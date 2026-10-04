// Standalone dashboard test harness: runs the dashboard server against a mock
// Discord client (no real token, no gateway connection). Not part of the bot.
// Run from the repo root: node test/dashboard-test.js

const config = require('../config.json');

function makeChannel(id, name, guild, parentId, position, canSend) {
    return {
        id: id,
        name: name,
        type: 0,
        topic: 'topic of ' + name,
        parentId: parentId,
        rawPosition: position,
        isTextBased: () => true,
        permissionsFor: canSend === false ? () => ({ has: () => false }) : undefined,
        send: async content => {
            console.log(`[mock] SEND to #${name}: ${JSON.stringify(content).slice(0, 80)}`);
            return { id: 'mock-message-' + Math.random().toString(36).slice(2, 8) };
        },
        guild: guild
    };
}

function makeGuild(id, name, memberCount) {
    let guild = {
        id: id,
        name: name,
        memberCount: memberCount,
        ownerId: '1',
        iconURL: null,
        channels: { cache: new Map() }
    };

    return guild;
}

let guild_a = makeGuild('111111111111111111', 'osu cafe', 4200);
let guild_b = makeGuild('222222222222222222', 'taiko union', 1337);

let channels = new Map();

[
    makeChannel('100000000000000001', 'general', guild_a, null, 0),
    makeChannel('100000000000000002', 'osu-scores', guild_a, null, 1),
    makeChannel('100000000000000003', 'staff', guild_a, null, 2, false),
    makeChannel('100000000000000004', 'announcements', guild_a, null, 3),
    makeChannel('200000000000000001', 'general', guild_b, null, 0),
    makeChannel('200000000000000002', 'drums', guild_b, null, 1)
].forEach(channel => {
    channels.set(channel.id, channel);
    guild_a.channels.cache.set(channel.id, channel);
    guild_b.channels.cache.set(channel.id, channel);
});

// each channel only in its own guild's cache
guild_a.channels.cache = new Map([...channels].filter(([, c]) => c.guild === guild_a));
guild_b.channels.cache = new Map([...channels].filter(([, c]) => c.guild === guild_b));

let mock_client = {
    user: {
        id: '999999999999999999',
        tag: 'flowabot#0001',
        displayAvatarURL: () => null
    },
    ws: { ping: 37 },
    uptime: 4 * 3600 * 1000 + 12 * 60 * 1000,
    guilds: { cache: new Map([[guild_a.id, guild_a], [guild_b.id, guild_b]]) },
    channels: {
        cache: channels,
        fetch: async id => {
            if (channels.has(id)) return channels.get(id);
            throw new Error('Unknown Channel');
        }
    }
};

let commands = [
    { command: 'recent', aliases: null, description: ['Shows your recent osu! play.'], usage: '<user>', argsRequired: 0 },
    { command: ['top', 't'], description: ['Shows top plays.'], usage: '', argsRequired: 0 }
];
commands[0].command = ['recent', 'rs', 'r'];
commands[1].command = ['top', 't'];

const activity = require('../dashboard/activity.js');

// seed events: commands, messages
let base = Date.now() - 10 * 60 * 1000;

function fakeMsg(guild, channel, user_id, username, content) {
    return {
        guild: guild,
        channel: channel,
        author: { id: user_id, bot: false, username: username },
        content: content
    };
}

let seed = [
    [guild_a, channels.get('100000000000000001'), '41', 'mrekk', ';rs mrekk'],
    [guild_a, channels.get('100000000000000001'), '42', 'pipa', 'anyone up for a match?'],
    [guild_a, channels.get('100000000000000002'), '43', 'rustbell', ';top pipa +hd'],
    [guild_b, channels.get('200000000000000001'), '44', 'tengoku', 'nice drum roll lol'],
    [guild_b, channels.get('200000000000000002'), '41', 'mrekk', ';rs'],
    [guild_a, channels.get('100000000000000001'), '45', 'loli', ';rs <script>alert(1)</script>']
];

seed.forEach((row, i) => {
    let [guild, channel, user_id, username, content] = row;
    let msg = fakeMsg(guild, channel, user_id, username, content);

    if (content.startsWith(';'))
        activity.logDiscordEvent(msg, 'command', { command: content.slice(1).split(' ')[0].split('+')[0], content: content });
    else
        activity.logDiscordEvent(msg, 'message', { content: content });
});

// stagger timestamps so the feed isn't all "just now"
// (activity.js stamps Date.now(); acceptable for a mock test)

const server = require('../dashboard/server.js');

server.init({ client: mock_client, commands: commands, config: config });

console.log('[test] dashboard test harness running on http://localhost:8080 (password: ' + config.dashboard.password + ')');
