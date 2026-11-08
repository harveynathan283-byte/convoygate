import { Client, GatewayIntentBits } from "discord.js";

export class DiscordManager {
  private client: Client | null = null;
  private guildId: string;
  private subscriberRoleId: string;

  constructor(token?: string, guildId?: string, roleId?: string) {
    this.guildId = guildId || "";
    this.subscriberRoleId = roleId || "";

    if (token && guildId && roleId) {
      this.client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
      });

      this.client.login(token).catch((err) => {
        console.warn("[Discord] Bot login failed:", err.message);
      });
    } else {
      console.log("[Discord] Bot credentials not set yet. Running in simulation mode.");
    }
  }

  public async setSubscriberRole(discordUserId: string, active: boolean) {
    if (!this.client || !this.client.isReady()) {
      console.log(`[Discord Sim] User ${discordUserId} subscription set to: ${active ? "ACTIVE" : "INACTIVE"}`);
      return;
    }

    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const member = await guild.members.fetch(discordUserId);

      if (active) {
        await member.roles.add(this.subscriberRoleId);
      } else {
        await member.roles.remove(this.subscriberRoleId);
      }
    } catch (err: any) {
      console.error(`[Discord] Failed modifying role for ${discordUserId}:`, err.message);
    }
  }
}