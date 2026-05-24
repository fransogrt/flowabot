# flowabot

Discord bot focused on osu! features. Shows scorecards, stat lookups, beatmap renders, pp calculations, and more. Also supports League of Legends and Valorant profile commands.

Full command list: [COMMANDS.md](COMMANDS.md)

---

## Installation

### Prerequisites

- Node.js 14 or higher
- node-gyp — [installation guide](https://github.com/nodejs/node-gyp#installation)
- gcc/g++ (e.g. `sudo apt install build-essential` on Ubuntu)
- node-canvas dependencies — [installation guide](https://github.com/Automattic/node-canvas#compiling)
- Discord bot token and client ID — [Discord Developer Portal](https://discord.com/developers/applications/)
- osu! OAuth credentials (client ID + secret) — [osu! account settings](https://osu.ppy.sh/home/account/edit#oauth)

### Setup

```bash
git clone https://github.com/fransogrt/flowabot.git
cd flowabot
npm install
```

Run the configuration wizard:

```bash
npm run config
```

Follow the prompts. Press Enter to skip optional features.

Start the bot:

```bash
npm start
```

If you provided a Discord client ID during config, you'll get an invite link to add the bot to your server.

### Optional: grade emojis

Upload S/A/B rank emojis to a server the bot has access to:

```bash
npm run emojis
```

### Optional: run in background (Linux)

```bash
npm install -g pm2
pm2 start npm --name flowabot -- start
pm2 save && pm2 startup
```

### Optional credentials

Some commands require additional API keys set in `config.json`:

| Key | Command | Where to get |
|-----|---------|--------------|
| `credentials.riot_api_key` | `;lol` | [Riot Developer Portal](https://developer.riotgames.com/) |
| `credentials.henrikdev_key` | `;val` | [Henrik Dev API](https://docs.henrikdev.xyz/) |
