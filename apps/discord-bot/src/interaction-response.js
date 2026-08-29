import { MessageFlags } from 'discord.js';

const slowCommands = new Set([
  'vr-parar', 'vr-listar-gravacoes', 'vr-listar-vozes',
  'vr-limpar-gravacoes', 'vr-clonar-voz', 'vr-tts',
  'vr-tocar',
  'vr-cancelar-processo',
]);

export function logInteraction(interaction, stage) {
  const age = Number.isFinite(interaction.createdTimestamp)
    ? ` idade=${Math.max(0, Date.now() - interaction.createdTimestamp)}ms` : '';
  // Log neither option values (texts/URLs) nor interaction tokens.
  console.log(`[interacao ${interaction.id ?? '?'}] /${interaction.commandName} ${stage}${age}`);
}

export async function acknowledgeCommand(interaction) {
  if (!slowCommands.has(interaction.commandName)) return;
  // Must happen before filesystem work, member fetches or other async checks.
  logInteraction(interaction, 'confirmando recebimento');
  await interaction.deferReply(interaction.commandName === 'vr-parar'
    ? {} : { flags: MessageFlags.Ephemeral });
  logInteraction(interaction, 'recebimento confirmado');
}

export async function replyToCommand(interaction, payload) {
  logInteraction(interaction, 'enviando resposta');
  let result;
  if (!interaction.deferred && !interaction.replied) result = await interaction.reply(payload);
  else if (typeof payload === 'string') result = await interaction.editReply(payload);
  else {
    const { ephemeral, ...editable } = payload;
    result = await interaction.editReply(editable);
  }
  logInteraction(interaction, 'resposta enviada');
  return result;
}
