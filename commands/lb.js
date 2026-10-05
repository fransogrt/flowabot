const osu = require('../osu.js');
const helper = require('../helper.js');
const { EmbedBuilder } = require('discord.js');

/**
 * One osu! player row of the server leaderboard.
 *
 * @typedef {Object} LeaderboardEntry
 * @property {string} ign
 * @property {number} pp
 * @property {number|null} global_rank
 */

// Entries per page of the paginated leaderboard.
const PAGE_SIZE = 10;
// Lifetime of the reaction navigation (consumed by the pagination task; the
// message simply stays on its last page once it expires).
const NAVIGATION_TTL_MS = 120000;

// Medals for the overall top 3; the medal replaces the position number.
const MEDALS = ['🥇', '🥈', '🥉'];

// Promisified wrapper over the callback-style domain function (osu.js keeps
// its error-first callbacks; new code is async/await).
function getUserStats(ign){
    return new Promise((resolve, reject) => {
        osu.get_user_stats({ u: ign }, (err, stats) => {
            if(err)
                reject(err);
            else
                resolve(stats);
        });
    });
}

// Intersect the read-only user_ign map with the guild's current members and
// query the stats of every linked player present, one at a time. Unresolvable
// IGNs are skipped without aborting; duplicate osu! accounts keep the first
// link; empty links are discarded.
// @returns {Promise<LeaderboardEntry[]>}
async function collectEntries(user_ign, guild){
    const members = await guild.members.fetch();

    let entries = [];
    let seen_ids = new Set();

    for(const [user_id, ign] of Object.entries(user_ign)){
        if(!members.has(user_id))
            continue;

        if(typeof ign != 'string' || ign.trim().length == 0)
            continue;

        const stats = await getUserStats(ign);

        if(!stats)
            continue;

        if(seen_ids.has(stats.id))
            continue;

        seen_ids.add(stats.id);
        entries.push({ ign: stats.username, pp: stats.pp, global_rank: stats.global_rank });
    }

    return entries;
}

// Total deterministic order (Req 3.1-3.3): pp descending; ties broken by the
// better (lower) global rank; double ties broken alphabetically by IGN
// (locale collation 'en'). Entries without a global rank sort after ranked
// ones of the same pp. Returns a new array; the input is never mutated.
// @param {LeaderboardEntry[]} entries
// @returns {LeaderboardEntry[]}
function sortEntries(entries){
    return entries.slice().sort((a, b) =>
        (b.pp - a.pp)
        || ((a.global_rank ?? Infinity) - (b.global_rank ?? Infinity))
        || a.ign.localeCompare(b.ign, 'en')
    );
}

// Slice the sorted ranking into consecutive pages of PAGE_SIZE entries.
// @param {LeaderboardEntry[]} entries
// @returns {LeaderboardEntry[][]}
function buildPages(entries){
    const pages = [];
    for(let i = 0; i < entries.length; i += PAGE_SIZE)
        pages.push(entries.slice(i, i + PAGE_SIZE));
    return pages;
}

// Render one page as an embed. Players are identified only by their osu! IGN
// (never a Discord mention); positions count continuously across pages
// (position = page * PAGE_SIZE + line + 1); the top 3 overall wear medals in
// place of the number; pp is rounded and shown with a thousands separator;
// the global rank is '#<rank>' or '—' when the player has none. The footer
// with totals and page indicator appears only when there is more than one
// page (Req 4.1-4.4).
// @param {Guild} guild
// @param {LeaderboardEntry[][]} pages
// @param {number} page 0-based page index
// @returns {EmbedBuilder}
function buildEmbed(guild, pages, page){
    const total = pages.reduce((sum, chunk) => sum + chunk.length, 0);

    const lines = pages[page].map((entry, i) => {
        const position = page * PAGE_SIZE + i + 1;
        const prefix = position <= 3 ? MEDALS[position - 1] : `${position}.`;
        const rank = entry.global_rank == null ? '—' : `#${entry.global_rank}`;
        return `${prefix} ${entry.ign} • ${Math.round(entry.pp).toLocaleString('en-US')}pp • ${rank}`;
    });

    const embed = new EmbedBuilder()
        .setTitle(`${guild.name} — osu! standard leaderboard`)
        .setDescription(lines.join('\n'));

    if(pages.length > 1)
        embed.setFooter({ text: `${total} players · Page ${page + 1}/${pages.length}` });

    return embed;
}

module.exports = {
    command: ['lb', 'leaderboard'],
    description: "Show a leaderboard of every linked osu! player in this server.",
    argsRequired: 0,
    usage: '(no arguments)',
    example: {
        run: "lb",
        result: "Returns the osu! leaderboard of the linked players in this server."
    },
    configRequired: ["credentials.client_id", "credentials.client_secret"],
    call: obj => {
        return new Promise((resolve, reject) => {
            (async () => {
                let { msg, user_ign } = obj;

                // guild-only guard: the guide resolves directly, nothing is sent (Req 1.2)
                if(!msg.guild){
                    resolve('This command can only be used in a server.');
                    return;
                }

                // immediate feedback before the N sequential stats queries (Req 1.1);
                // the result is always edited onto this single message
                const placeholder = await msg.channel.send('Building leaderboard… 🔄');

                let entries;
                try {
                    entries = await collectEntries(user_ign, msg.guild);
                } catch(err){
                    // osu! network/API failure or members.fetch failure: drop the
                    // placeholder so the standard error handling answers (Req 6.1)
                    await placeholder.delete().catch(() => {});
                    reject(err);
                    return;
                }

                // no linked players present: point at ;ign-set (Req 2.4)
                if(entries.length == 0){
                    await placeholder.edit('No osu! players linked in this server yet. Link yours with **;ign-set <username>**.');
                    resolve(null); // lb.js owns its message: index.js sends nothing
                    return;
                }

                // sorted ranking, sliced into pages, rendered onto the single
                // message as page 1 (navigation arrives with the pagination task)
                const sorted = sortEntries(entries);
                const pages = buildPages(sorted);
                await placeholder.edit({ embeds: [buildEmbed(msg.guild, pages, 0)] });
                resolve(null);
            })().catch(reject);
        });
    }
};
