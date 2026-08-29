import { SlashCommandBuilder } from 'discord.js';
import { replyToCommand } from './interaction-response.js';

export const botControlCommands = [
  new SlashCommandBuilder().setName('vr-status-bot')
    .setDescription('Mostra conexão, tempo online, gravação, processo atual e fila'),
  new SlashCommandBuilder().setName('vr-cancelar-processo')
    .setDescription('Cancela o trabalho atual deste servidor sem desligar o bot'),
];

export function createBotControlHandler({ operations, queue, sessions, canManage, build }) {
  return async (interaction) => {
    const guildId = interaction.guild.id;
    if (interaction.commandName === 'vr-status-bot') {
      const task = operations.current(guildId);
      const recorder = sessions.get(guildId);
      const seconds = Math.floor(process.uptime());
      const ping = interaction.client.ws?.ping;
      const content = [
        `**Situação do bot** — ${interaction.client.isReady() ? 'conectado' : 'reconectando'}`,
        `Versão: \`${build}\``,
        `Online: ${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}min | Ping: ${ping >= 0 ? `${Math.round(ping)} ms` : 'aguardando medição'}`,
        `Memória do bot (Node): ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MiB (não inclui Python/GPU)`,
        recorder ? `Gravação: ativa em <#${recorder.voiceChannel.id}> (${recorder.users.size} participante(s) capturado(s))` : 'Gravação: inativa',
        task ? `Processo deste servidor: **${task.kind}** — ${task.stage}` : 'Processo deste servidor: nenhum',
        ...(task ? [`Solicitado por <@${task.userId}> há ${Math.floor((Date.now() - task.startedAt) / 1000)}s.`] : []),
        `Fila global: ${queue.size} trabalho(s), ${queue.waiting} aguardando.`,
      ].join('\n');
      await replyToCommand(interaction, { content, ephemeral: true, allowedMentions: { parse: [] } });
      return true;
    }
    if (interaction.commandName !== 'vr-cancelar-processo') return false;
    const task = operations.current(guildId);
    if (!task) {
      await replyToCommand(interaction, { content: 'Não há processamento para cancelar neste servidor. Para encerrar uma gravação, use `/vr-parar`.', ephemeral: true });
      return true;
    }
    if (task.userId !== interaction.user.id && !await canManage(interaction)) {
      await replyToCommand(interaction, { content: 'Somente quem iniciou o processo ou um moderador com **Gerenciar canais** pode cancelá-lo.', ephemeral: true });
      return true;
    }
    const cancelled = operations.cancel(task);
    await replyToCommand(interaction, {
      content: cancelled
        ? `⏹️ Cancelamento de **${task.kind}** solicitado. Aguarde o encerramento e a limpeza; o bot continuará online.`
        : 'Esse processo já terminou ou já está sendo cancelado. Consulte `/vr-status-bot`.',
      ephemeral: true,
    });
    return true;
  };
}
