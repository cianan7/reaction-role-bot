const fs = require("fs");
const path = require("path");

const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
    REST,
    Routes
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // optional - makes slash commands appear instantly

// How many emoji/role pairs one message can hold.
const MAX_PAIRS = 5;

// ================================
// STARTUP CHECKS
// ================================

console.log("TOKEN:", TOKEN ? `found, ${TOKEN.length} chars` : "MISSING");
console.log("CLIENT_ID:", CLIENT_ID ? `found, ${CLIENT_ID}` : "MISSING");
console.log("GUILD_ID:", GUILD_ID ? `found, ${GUILD_ID}` : "not set (using global commands)");

if (!TOKEN) {
    console.error("DISCORD_TOKEN is not set. Check the Startup page in your panel.");
    process.exit(1);
}

if (!CLIENT_ID) {
    console.error("CLIENT_ID is not set. Check the Startup page in your panel.");
    process.exit(1);
}

// ================================
// PERSISTENCE
// ================================

const DATA_FILE = path.join(process.cwd(), "reaction-roles.json");

// key = "messageId:emojiKey"  ->  value = roleId
let reactionRoles = new Map();

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            console.log("No saved data file yet - starting fresh.");
            return;
        }

        const raw = fs.readFileSync(DATA_FILE, "utf8");
        const parsed = JSON.parse(raw);

        reactionRoles = new Map(Object.entries(parsed));

        console.log(`Loaded ${reactionRoles.size} saved reaction role(s).`);
    } catch (error) {
        console.error("Could not load saved data, starting fresh:", error.message);
        reactionRoles = new Map();
    }
}

function saveData() {
    try {
        const asObject = Object.fromEntries(reactionRoles);
        fs.writeFileSync(DATA_FILE, JSON.stringify(asObject, null, 2), "utf8");
    } catch (error) {
        console.error("Could not save data:", error.message);
    }
}

loadData();

// ================================
// EMOJI KEY HELPERS
// ================================

// Custom emoji "<:name:12345>" -> "12345"
// Unicode emoji "*"            -> the emoji itself
function keyFromInput(input) {
    const custom = input.match(/<a?:\w+:(\d+)>/);
    return custom ? custom[1] : input.trim();
}

function keyFromReaction(emoji) {
    return emoji.id ? emoji.id : emoji.name;
}

function makeKey(messageId, emojiKey) {
    return `${messageId}:${emojiKey}`;
}

// ================================
// CLIENT
// ================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction
    ]
});

// ================================
// BOT READY
// ================================

client.once("clientReady", async () => {
    console.log(`Logged in as ${client.user.tag}`);

    client.user.setPresence({
        activities: [{ name: "Reaction Roles", type: 0 }],
        status: "online"
    });

    const reactionRoleCommand = new SlashCommandBuilder()
        .setName("reactionrole")
        .setDescription("Create a reaction role message with up to 5 roles")
        .addStringOption(option =>
            option
                .setName("emoji")
                .setDescription("Emoji for the first role")
                .setRequired(true)
        )
        .addRoleOption(option =>
            option
                .setName("role")
                .setDescription("First role to give")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("title")
                .setDescription("Title of the message")
                .setRequired(false)
        )
        .addStringOption(option =>
            option
                .setName("description")
                .setDescription("Description of the message")
                .setRequired(false)
        );

    // Adds emoji2/role2 through emoji5/role5 as optional extras.
    for (let i = 2; i <= MAX_PAIRS; i++) {
        reactionRoleCommand
            .addStringOption(option =>
                option
                    .setName(`emoji${i}`)
                    .setDescription(`Emoji for role number ${i}`)
                    .setRequired(false)
            )
            .addRoleOption(option =>
                option
                    .setName(`role${i}`)
                    .setDescription(`Role number ${i}`)
                    .setRequired(false)
            );
    }

    const commands = [
        reactionRoleCommand,
        new SlashCommandBuilder()
            .setName("reactionrole-list")
            .setDescription("Show all saved reaction role mappings")
    ].map(command => command.toJSON());

    const rest = new REST({ version: "10" }).setToken(TOKEN);

    try {
        if (GUILD_ID) {
            await rest.put(
                Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
                { body: commands }
            );
            console.log("Slash commands registered for your server (instant).");
        } else {
            await rest.put(
                Routes.applicationCommands(CLIENT_ID),
                { body: commands }
            );
            console.log("Slash commands registered globally (can take up to 1 hour to appear).");
        }
    } catch (error) {
        console.error("Failed to register slash commands:", error);
    }
});

// ================================
// SHARED REACTION HANDLER
// ================================

async function handleReaction(reaction, user, action) {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error("Could not fetch reaction:", error.message);
            return;
        }
    }

    if (!reaction.message.guild) return;

    const key = makeKey(reaction.message.id, keyFromReaction(reaction.emoji));
    const roleId = reactionRoles.get(key);

    if (!roleId) return;

    try {
        const member = await reaction.message.guild.members.fetch(user.id);

        if (action === "add") {
            await member.roles.add(roleId);
            console.log(`Gave role ${roleId} to ${user.tag}`);
        } else {
            await member.roles.remove(roleId);
            console.log(`Removed role ${roleId} from ${user.tag}`);
        }
    } catch (error) {
        console.error(`Couldn't ${action} role:`, error.message);
    }
}

client.on("messageReactionAdd", (reaction, user) => {
    handleReaction(reaction, user, "add");
});

client.on("messageReactionRemove", (reaction, user) => {
    handleReaction(reaction, user, "remove");
});

// ================================
// SLASH COMMANDS
// ================================

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // ---------- /reactionrole-list ----------
    if (interaction.commandName === "reactionrole-list") {
        if (reactionRoles.size === 0) {
            return interaction.reply({
                content: "No reaction roles saved yet.",
                flags: MessageFlags.Ephemeral
            });
        }

        const lines = [...reactionRoles.entries()].map(([key, roleId]) => {
            const [messageId, emojiKey] = key.split(":");
            return `Message \`${messageId}\` - ${emojiKey} -> <@&${roleId}>`;
        });

        return interaction.reply({
            content: lines.join("\n").slice(0, 1900),
            flags: MessageFlags.Ephemeral
        });
    }

    // ---------- /reactionrole ----------
    if (interaction.commandName !== "reactionrole") return;

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
        console.error("Could not defer reply:", error.message);
        return;
    }

    if (!interaction.guild) {
        return interaction.editReply({
            content: "This command only works inside a server."
        });
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply({
            content: "You need **Manage Roles** permission to use this command."
        });
    }

    // ---------- collect the emoji/role pairs ----------
    const pairs = [];

    for (let i = 1; i <= MAX_PAIRS; i++) {
        const suffix = i === 1 ? "" : String(i);
        const emoji = interaction.options.getString(`emoji${suffix}`);
        const role = interaction.options.getRole(`role${suffix}`);

        if (emoji && role) {
            pairs.push({ emoji: emoji.trim(), role });
        } else if (emoji || role) {
            return interaction.editReply({
                content: `Pair ${i} is incomplete - you need both \`emoji${suffix}\` and \`role${suffix}\` filled in.`
            });
        }
    }

    // ---------- reject duplicate emoji ----------
    const seen = new Set();

    for (const pair of pairs) {
        const key = keyFromInput(pair.emoji);

        if (seen.has(key)) {
            return interaction.editReply({
                content: `You used ${pair.emoji} more than once. Each emoji can only map to one role.`
            });
        }

        seen.add(key);
    }

    // ---------- check the bot can actually assign these roles ----------
    let me;

    try {
        me = await interaction.guild.members.fetchMe();
    } catch (error) {
        console.error("Could not fetch my own member object:", error.message);
        return interaction.editReply({
            content: "I couldn't check my own permissions. Try re-inviting me with the bot scope."
        });
    }

    for (const pair of pairs) {
        if (pair.role.position >= me.roles.highest.position) {
            return interaction.editReply({
                content: `I can't assign **${pair.role.name}** because it sits above my own role. Go to Server Settings > Roles and drag **${me.roles.highest.name}** above it.`
            });
        }

        if (pair.role.managed) {
            return interaction.editReply({
                content: `**${pair.role.name}** is managed by an integration and can't be assigned manually.`
            });
        }
    }

    // ---------- build and send the message ----------
    const title = interaction.options.getString("title") || "Reaction Roles";
    const description =
        interaction.options.getString("description") ||
        "React below to receive your role.";

    const roleLines = pairs
        .map(pair => `${pair.emoji} - ${pair.role}`)
        .join("\n");

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(`${description}\n\n${roleLines}`)
        .setTimestamp();

    let message;

    try {
        message = await interaction.channel.send({ embeds: [embed] });
    } catch (error) {
        return interaction.editReply({
            content: "I couldn't post the message. Do I have permission to send messages and embeds in this channel?"
        });
    }

    // ---------- add the reactions ----------
    for (const pair of pairs) {
        try {
            await message.react(pair.emoji);
        } catch (error) {
            await message.delete().catch(() => {});
            return interaction.editReply({
                content: `I couldn't react with ${pair.emoji}. Use a standard emoji, or a custom emoji from a server I'm in.`
            });
        }
    }

    // ---------- save ----------
    for (const pair of pairs) {
        reactionRoles.set(
            makeKey(message.id, keyFromInput(pair.emoji)),
            pair.role.id
        );
    }

    saveData();

    await interaction.editReply({
        content: `Reaction role message created with ${pairs.length} role${pairs.length === 1 ? "" : "s"}. Saved - it will survive restarts.`
    });
});

// ================================
// ERROR SAFETY NET
// ================================

client.on("error", error => {
    console.error("Client error:", error);
});

process.on("unhandledRejection", error => {
    console.error("Unhandled rejection:", error);
});

// ================================
// LOGIN
// ================================

client.login(TOKEN);
