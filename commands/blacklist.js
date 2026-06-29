const helper = require('../helper.js');

function loadBlacklist() {
    let raw = helper.getItem('blacklist');
    return raw ? JSON.parse(raw) : [];
}

function saveBlacklist(list) {
    helper.setItem('blacklist', JSON.stringify(list));
}

module.exports = {
    command: ['blacklist'],
    description: "Add or remove a user from the command blacklist (server owner only).",
    argsRequired: 1,
    usage: '<add|remove> <@user or user_id>',
    example: [
        { run: "blacklist add 123456789", result: "Blocks user 123456789 from using bot commands." },
        { run: "blacklist remove 123456789", result: "Unblocks user 123456789." }
    ],
    call: obj => {
        return new Promise((resolve, reject) => {
            let { argv, msg } = obj;

            if (msg.author.id !== '616759777468481546') {
                reject("You don't have permission to use this command.");
                return;
            }

            let action = argv[1]?.toLowerCase();
            let target = argv[2];

            if (!target || !['add', 'remove'].includes(action)) {
                reject(helper.commandHelp('blacklist'));
                return;
            }

            let user_id = target.replace(/[<@!>]/g, '');

            if (!/^\d+$/.test(user_id)) {
                reject("Invalid user ID.");
                return;
            }

            let list = loadBlacklist();

            if (action === 'add') {
                if (list.includes(user_id)) {
                    reject(`User \`${user_id}\` is already blacklisted.`);
                    return;
                }
                list.push(user_id);
                saveBlacklist(list);
                resolve(`User \`${user_id}\` added to blacklist.`);
            } else {
                if (!list.includes(user_id)) {
                    reject(`User \`${user_id}\` is not in the blacklist.`);
                    return;
                }
                list = list.filter(id => id !== user_id);
                saveBlacklist(list);
                resolve(`User \`${user_id}\` removed from blacklist.`);
            }
        });
    }
};
