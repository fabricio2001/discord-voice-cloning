import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

function safeSegment(value) {
  return value.normalize('NFKD').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'usuario';
}

const PCM_BYTES_PER_SECOND = 48_000 * 2 * 2;
export const MIN_REFERENCE_SECONDS = 3;

async function findFiles(root, filename) {
  const matches = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === filename) matches.push(path);
    }));
  };
  await visit(root);
  return matches;
}

export async function listRecordings(recordingsRoot, guildId) {
  const manifests = await findFiles(recordingsRoot, 'manifest.json');
  const recordings = [];

  for (const manifestPath of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (manifest.guildId !== guildId) continue;

    for (const user of manifest.users ?? []) {
      const filePath = resolve(dirname(manifestPath), user.filename);
      const fileSize = await stat(filePath).then((item) => item.size).catch(() => 0);
      const pcmBytes = Number.isFinite(user.pcmBytes)
        ? user.pcmBytes
        : Math.max(0, fileSize - 44);
      const key = `${basename(dirname(manifestPath))}|${user.userId}`;
      recordings.push({
        key,
        filePath,
        manifestPath,
        sessionPath: dirname(manifestPath),
        session: basename(dirname(manifestPath)),
        startedAt: manifest.startedAt,
        ...user,
        pcmBytes,
        durationSeconds: pcmBytes / PCM_BYTES_PER_SECOND,
        usableForCloning: pcmBytes >= MIN_REFERENCE_SECONDS * PCM_BYTES_PER_SECOND,
      });
    }
  }

  return recordings.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function findRecording(recordingsRoot, guildId, key) {
  return (await listRecordings(recordingsRoot, guildId)).find((item) => item.key === key) ?? null;
}

function assertInside(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error('Caminho de gravação inválido; a limpeza foi cancelada.');
  }
  return resolvedTarget;
}

export async function deleteRecordings(recordingsRoot, guildId, scope, target = '') {
  const recordings = await listRecordings(recordingsRoot, guildId);
  let selected = [];

  if (scope === 'todas') selected = recordings;
  else if (scope === 'dia') selected = recordings.filter((item) => item.startedAt.slice(0, 10) === target);
  else if (scope === 'sessao') selected = recordings.filter((item) => item.session === target);
  else if (scope === 'pessoa') selected = recordings.filter((item) => item.userId === target);
  else if (scope === 'arquivo') {
    selected = recordings.filter((item) => item.key === target);
    if (selected.length === 0) {
      const byFilename = recordings.filter((item) => item.filename.toLowerCase() === target.toLowerCase());
      if (byFilename.length > 1) {
        throw new Error('Esse nome existe em mais de uma sessão. Escolha o arquivo pelo autocomplete.');
      }
      selected = byFilename;
    }
  } else {
    throw new Error('Escopo de limpeza inválido.');
  }

  if (selected.length === 0) return { files: 0, sessions: 0 };

  const wholeSession = scope === 'todas' || scope === 'dia' || scope === 'sessao';
  if (wholeSession) {
    const sessionPaths = [...new Set(selected.map((item) => item.sessionPath))];
    for (const sessionPath of sessionPaths) {
      await rm(assertInside(recordingsRoot, sessionPath), { recursive: true, force: true });
    }
    return { files: selected.length, sessions: sessionPaths.length };
  }

  const byManifest = Map.groupBy(selected, (item) => item.manifestPath);
  let removedSessions = 0;
  for (const [manifestPath, items] of byManifest) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const keys = new Set(items.map((item) => `${item.userId}|${item.filename}`));
    manifest.users = (manifest.users ?? []).filter(
      (user) => !keys.has(`${user.userId}|${user.filename}`),
    );

    for (const item of items) {
      await rm(assertInside(recordingsRoot, item.filePath), { force: true });
    }
    if (manifest.users.length === 0) {
      await rm(assertInside(recordingsRoot, dirname(manifestPath)), { recursive: true, force: true });
      removedSessions += 1;
    } else {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    }
  }
  return { files: selected.length, sessions: removedSessions };
}

export async function listVoices(voicesRoot, guildId) {
  const guildRoot = join(voicesRoot, guildId);
  const files = await readdir(guildRoot).catch(() => []);
  const voices = [];
  for (const filename of files.filter((name) => name.endsWith('.json'))) {
    try {
      const voice = JSON.parse(await readFile(join(guildRoot, filename), 'utf8'));
      if (voice.guildId === guildId) {
        voices.push({
          ...voice,
          // Resolve from the current catalog root so moving the project does not
          // leave references pointing at an obsolete absolute directory.
          referencePath: voiceReferencePath(voicesRoot, guildId, voice.id),
        });
      }
    } catch {
      // Ignore incomplete/corrupt catalog entries and keep the other voices usable.
    }
  }
  return voices.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveVoice(voicesRoot, guildId, recording, createdBy) {
  const guildRoot = join(voicesRoot, guildId);
  await mkdir(guildRoot, { recursive: true });
  const id = recording.userId;
  const referencePath = join(guildRoot, `${safeSegment(id)}.wav`);
  const metadataPath = join(guildRoot, `${safeSegment(id)}.json`);
  const metadata = {
    id,
    guildId,
    userId: recording.userId,
    username: recording.username,
    displayName: recording.displayName,
    referenceFile: basename(referencePath),
    sourceRecording: relative(resolve(voicesRoot, '..'), recording.filePath).split(sep).join('/'),
    createdAt: new Date().toISOString(),
    createdBy,
  };
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  return { ...metadata, referencePath };
}

export async function findVoice(voicesRoot, guildId, id) {
  return (await listVoices(voicesRoot, guildId)).find((voice) => voice.id === id) ?? null;
}

export function voiceReferencePath(voicesRoot, guildId, userId) {
  return join(voicesRoot, guildId, `${safeSegment(userId)}.wav`);
}
