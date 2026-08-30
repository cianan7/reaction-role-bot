const fs = require("fs");
const path = require("path");

const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    AttachmentBuilder,
    ChannelType,
    MessageFlags,
    PermissionFlagsBits,
    REST,
    Routes
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const MAX_PAIRS = 5;

console.log("TOKEN:", TOKEN ? `found, ${TOKEN.length} chars` : "MISSING");
console.log("CLIENT_ID:", CLIENT_ID ? `found, ${CLIENT_ID}` : "MISSING");
console.log("GUILD_ID:", GUILD_ID ? `found, ${GUILD_ID}` : "not set (using global commands)");

if (!TOKEN) {
    console.error("DISCORD_TOKEN is not set.");
    process.exit(1);
}

if (!CLIENT_ID) {
    console.error("CLIENT_ID is not set.");
    process.exit(1);
}

// ================================
// WHERE DATA IS SAVED
// ================================
// If you attached a Railway volume at /data it is used automatically.
// Otherwise files sit next to the code and are lost on redeploy.

const DATA_DIR = fs.existsSync("/data") ? "/data" : process.cwd();

console.log("Saving data in:", DATA_DIR);

const ROLES_FILE = path.join(DATA_DIR, "reaction-roles.json");
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        console.error(`Could not read ${file}:`, error.message);
        return fallback;
    }
}

function writeJson(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
        console.error(`Could not write ${file}:`, error.message);
    }
}

// ---------- reaction roles ----------

let reactionRoles = new Map(Object.entries(readJson(ROLES_FILE, {})));

console.log(`Loaded ${reactionRoles.size} saved reaction role(s).`);

function saveRoles() {
    writeJson(ROLES_FILE, Object.fromEntries(reactionRoles));
}

// ---------- tickets ----------
// { config: { supportRoleId, logChannelId, categoryId }, counter: 0, open: { channelId: {...} } }

let ticketData = readJson(TICKETS_FILE, { config: {}, panels: {}, counter: 0, open: {} });

if (!ticketData.config) ticketData.config = {};
if (!ticketData.panels) ticketData.panels = {};
if (!ticketData.counter) ticketData.counter = 0;
if (!ticketData.open) ticketData.open = {};

// Friendly names for the game codes used in channel names.
const GAMES = {
    ow: "Overwatch",
    lol: "League of Legends",
    wow: "World of Warcraft"
};

console.log(`Ticket system: ${Object.keys(ticketData.open).length} open ticket(s), ${ticketData.counter} created all time.`);

function saveTickets() {
    writeJson(TICKETS_FILE, ticketData);
}

// ================================
// EMOJI HELPERS
// ================================

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
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction
    ]
});

// ================================
// READY
// ================================

client.once("clientReady", async () => {
    console.log(`Logged in as ${client.user.tag}`);

    client.user.setPresence({
        activities: [{ name: "Reaction Roles & Tickets", type: 0 }],
        status: "online"
    });

    const reactionRoleCommand = new SlashCommandBuilder()
        .setName("reactionrole")
        .setDescription("Create a reaction role message with up to 5 roles")
        .addStringOption(o => o.setName("emoji").setDescription("Emoji for the first role").setRequired(true))
        .addRoleOption(o => o.setName("role").setDescription("First role to give").setRequired(true))
        .addStringOption(o => o.setName("title").setDescription("Title of the message").setRequired(false))
        .addStringOption(o => o.setName("description").setDescription("Description of the message").setRequired(false));

    for (let i = 2; i <= MAX_PAIRS; i++) {
        reactionRoleCommand
            .addStringOption(o => o.setName(`emoji${i}`).setDescription(`Emoji for role number ${i}`).setRequired(false))
            .addRoleOption(o => o.setName(`role${i}`).setDescription(`Role number ${i}`).setRequired(false));
    }

    const commands = [
        reactionRoleCommand,

        new SlashCommandBuilder()
            .setName("reactionrole-list")
            .setDescription("Show all saved reaction role mappings"),

        new SlashCommandBuilder()
            .setName("ticket-setup")
            .setDescription("Set up the ticket system (do this first)")
            .addRoleOption(o =>
                o.setName("support_role")
                    .setDescription("Role that can see and answer tickets")
                    .setRequired(true))
            .addChannelOption(o =>
                o.setName("log_channel")
                    .setDescription("Channel where closed ticket transcripts are posted")
                    .addChannelTypes(ChannelType.GuildText)
                    .setRequired(true))
            .addChannelOption(o =>
                o.setName("category")
                    .setDescription("Category new ticket channels are created under")
                    .addChannelTypes(ChannelType.GuildCategory)
                    .setRequired(false)),

        new SlashCommandBuilder()
            .setName("ticket-panel")
            .setDescription("Post a ticket panel for one game")
            .addStringOption(o =>
                o.setName("game")
                    .setDescription("Which game this panel is for")
                    .setRequired(true)
                    .addChoices(
                        { name: "Overwatch", value: "ow" },
                        { name: "League of Legends", value: "lol" },
                        { name: "World of Warcraft", value: "wow" }
                    ))
            .addChannelOption(o =>
                o.setName("category")
                    .setDescription("Category this game's tickets are created under")
                    .addChannelTypes(ChannelType.GuildCategory)
                    .setRequired(false))
            .addRoleOption(o =>
                o.setName("support_role")
                    .setDescription("Staff role for this game (defaults to the one from /ticket-setup)")
                    .setRequired(false))
            .addStringOption(o => o.setName("title").setDescription("Panel title").setRequired(false))
            .addStringOption(o => o.setName("description").setDescription("Panel text").setRequired(false)),

        new SlashCommandBuilder()
            .setName("ticket-menu")
            .setDescription("Post one panel with a game dropdown (for #apply)")
            .addChannelOption(o =>
                o.setName("wow_category")
                    .setDescription("Category for PS WOW tickets")
                    .addChannelTypes(ChannelType.GuildCategory)
                    .setRequired(false))
            .addChannelOption(o =>
                o.setName("ow_category")
                    .setDescription("Category for PS OW tickets")
                    .addChannelTypes(ChannelType.GuildCategory)
                    .setRequired(false))
            .addChannelOption(o =>
                o.setName("lol_category")
                    .setDescription("Category for PS LOL tickets")
                    .addChannelTypes(ChannelType.GuildCategory)
                    .setRequired(false))
            .addStringOption(o => o.setName("title").setDescription("Panel title").setRequired(false))
            .addStringOption(o => o.setName("description").setDescription("Panel text above the dropdown").setRequired(false)),

        new SlashCommandBuilder()
            .setName("ticket-debug")
            .setDescription("Show what permissions I actually have and where tickets would go"),

        new SlashCommandBuilder()
            .setName("ticket-close")
            .setDescription("Close the ticket you are currently in")
    ].map(c => c.toJSON());

    const rest = new REST({ version: "10" }).setToken(TOKEN);

    try {
        if (GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
            console.log("Slash commands registered for your server (instant).");
        } else {
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
            console.log("Slash commands registered globally (up to 1 hour).");
        }
    } catch (error) {
        console.error("Failed to register slash commands:", error);
    }
});

// ================================
// REACTION ROLES
// ================================

async function handleReaction(reaction, user, action) {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            return;
        }
    }

    if (!reaction.message.guild) return;

    const roleId = reactionRoles.get(makeKey(reaction.message.id, keyFromReaction(reaction.emoji)));

    if (!roleId) return;

    try {
        const member = await reaction.message.guild.members.fetch(user.id);

        if (action === "add") {
            await member.roles.add(roleId);
        } else {
            await member.roles.remove(roleId);
        }
    } catch (error) {
        console.error(`Couldn't ${action} role:`, error.message);
    }
}

client.on("messageReactionAdd", (r, u) => handleReaction(r, u, "add"));
client.on("messageReactionRemove", (r, u) => handleReaction(r, u, "remove"));

// ================================
// TRANSCRIPT BUILDER
// ================================

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

async function buildTranscript(channel, info) {
    const collected = [];
    let lastId;

    // Grab up to 1000 messages, oldest first.
    for (let i = 0; i < 10; i++) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const batch = await channel.messages.fetch(options);
        if (batch.size === 0) break;

        collected.push(...batch.values());
        lastId = batch.last().id;

        if (batch.size < 100) break;
    }

    collected.reverse();

    const rows = collected.map(message => {
        const time = new Date(message.createdTimestamp).toLocaleString("en-GB");
        const author = escapeHtml(message.author.tag);
        const body = escapeHtml(message.content || "");

        const files = message.attachments
            .map(a => `<div class="file"><a href="${a.url}">${escapeHtml(a.name)}</a></div>`)
            .join("");

        const embeds = message.embeds.length
            ? `<div class="embed">[embed] ${escapeHtml(message.embeds[0].title || "")} ${escapeHtml(message.embeds[0].description || "")}</div>`
            : "";

        return `<div class="msg"><div class="meta"><span class="author">${author}</span><span class="time">${time}</span></div><div class="body">${body}</div>${embeds}${files}</div>`;
    }).join("\n");

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Ticket ${info.number} transcript</title>
<style>
body{background:#313338;color:#dbdee1;font-family:'gg sans',Arial,sans-serif;margin:0;padding:24px;}
h1{color:#fff;font-size:20px;margin:0 0 4px;}
.header{border-bottom:1px solid #3f4147;padding-bottom:16px;margin-bottom:16px;}
.header div{font-size:13px;color:#b5bac1;margin-top:2px;}
.msg{padding:8px 0;border-bottom:1px solid #2b2d31;}
.meta{font-size:12px;margin-bottom:2px;}
.author{color:#fff;font-weight:600;margin-right:8px;}
.time{color:#949ba4;}
.body{white-space:pre-wrap;word-wrap:break-word;}
.embed{border-left:3px solid #5865f2;padding-left:8px;margin-top:4px;color:#b5bac1;font-size:14px;}
.file a{color:#00a8fc;font-size:14px;}
</style></head><body>
<div class="header">
<h1>Ticket #${info.number}</h1>
<div>Opened by: ${escapeHtml(info.openerTag)}</div>
<div>Closed by: ${escapeHtml(info.closerTag)}</div>
<div>Closed at: ${new Date().toLocaleString("en-GB")}</div>
<div>Messages: ${collected.length}</div>
</div>
${rows || "<div class='msg'><div class='body'>No messages.</div></div>"}
</body></html>`;

    return { html, count: collected.length };
}

// ================================
// TICKET ACTIONS
// ================================

async function createTicket(interaction, game) {
    const config = ticketData.config;
    const panel = ticketData.panels[game] || {};

    const supportRoleId = panel.supportRoleId || config.supportRoleId;
    const categoryId = panel.categoryId || config.categoryId || null;

    if (!supportRoleId || !config.logChannelId) {
        return interaction.editReply({
            content: "The ticket system has not been set up yet. An admin needs to run /ticket-setup first."
        });
    }

    // One open ticket per person per game.
    const existing = Object.entries(ticketData.open)
        .find(([, t]) => t.openerId === interaction.user.id && t.game === game);

    if (existing) {
        return interaction.editReply({
            content: `You already have an open ${GAMES[game] || game} ticket: <#${existing[0]}>`
        });
    }

    ticketData.counter += 1;
    const number = String(ticketData.counter).padStart(4, "0");

    // ticket-ow-cianan
    const safeName = interaction.user.username
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 20) || "user";

    const channelName = `ticket-${game}-${safeName}`;

    const overwrites = [
        {
            id: interaction.guild.roles.everyone.id,
            deny: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
            ]
        },
        {
            id: interaction.user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles
            ]
        },
        {
            id: supportRoleId,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles
            ]
        },
        {
            id: client.user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.AttachFiles
            ]
        }
    ];

    let channel;

    // Create with no parent first. A locked-down category can block
    // creation outright, so we make the channel free-standing, apply the
    // permissions, then move it into place.
    try {
        channel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            permissionOverwrites: overwrites
        });
    } catch (error) {
        console.error("Could not create ticket channel:", error.message);
        ticketData.counter -= 1;
        return interaction.editReply({
            content: "I couldn't create the channel. I need **Manage Channels** and **Manage Roles** at server level."
        });
    }

    // Now move it into the category, keeping our own permissions.
    if (categoryId) {
        try {
            await channel.setParent(categoryId, { lockPermissions: false });
        } catch (error) {
            console.error("Could not move ticket into category:", error.message);
        }
    }

    // Belt and braces: re-apply the deny after creation in case the
    // category's own permissions bled through on create.
    try {
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, {
            ViewChannel: false,
            SendMessages: false,
            ReadMessageHistory: false
        });

        await channel.permissionOverwrites.edit(interaction.user.id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true
        });
    } catch (error) {
        console.error("Could not re-apply ticket permissions:", error.message);
    }

    ticketData.open[channel.id] = {
        number,
        game,
        supportRoleId,
        openerId: interaction.user.id,
        openerTag: interaction.user.tag,
        createdAt: Date.now()
    };

    saveTickets();

    const embed = new EmbedBuilder()
        .setTitle(`${GAMES[game] || game} Ticket #${number}`)
        .setDescription("Support will be with you shortly. Describe your issue below with as much detail as you can.")
        .addFields(
            { name: "Opened by", value: `<@${interaction.user.id}>`, inline: true },
            { name: "Game", value: GAMES[game] || game, inline: true }
        )
        .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket_close").setLabel("Close").setStyle(ButtonStyle.Danger)
    );

    await channel.send({
        content: `<@${interaction.user.id}> <@&${supportRoleId}>`,
        embeds: [embed],
        components: [buttons]
    });

    await interaction.editReply({ content: `Ticket created: <#${channel.id}>` });
}

async function closeTicket(interaction) {
    const channel = interaction.channel;
    const ticket = ticketData.open[channel.id];

    if (!ticket) {
        return interaction.editReply({ content: "This isn't a ticket channel." });
    }

    // Only staff (or admins) may close.
    const staffRoleId = ticket.supportRoleId || ticketData.config.supportRoleId;

    const isStaff =
        interaction.member.roles.cache.has(staffRoleId) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

    if (!isStaff) {
        return interaction.editReply({
            content: "Only staff can close tickets. If you're finished, just say so and a staff member will close it for you."
        });
    }

    await interaction.editReply({ content: "Saving the transcript, then this channel will be deleted." });

    let transcript;

    try {
        transcript = await buildTranscript(channel, {
            number: ticket.number,
            openerTag: ticket.openerTag,
            closerTag: interaction.user.tag
        });
    } catch (error) {
        console.error("Transcript failed:", error.message);
        transcript = { html: "<html><body>Transcript failed.</body></html>", count: 0 };
    }

    const logChannel = interaction.guild.channels.cache.get(ticketData.config.logChannelId);

    if (logChannel) {
        const file = new AttachmentBuilder(
            Buffer.from(transcript.html, "utf8"),
            { name: `ticket-${ticket.number}.html` }
        );

        const logEmbed = new EmbedBuilder()
            .setTitle("Ticket Closed")
            .addFields(
                { name: "Ticket", value: `#${ticket.number}`, inline: true },
                { name: "Game", value: GAMES[ticket.game] || ticket.game || "Unknown", inline: true },
                { name: "Opened by", value: `<@${ticket.openerId}>`, inline: true },
                { name: "Closed by", value: `<@${interaction.user.id}>`, inline: true },
                { name: "Messages", value: String(transcript.count), inline: true },
                { name: "Opened at", value: `<t:${Math.floor(ticket.createdAt / 1000)}:f>`, inline: true }
            )
            .setFooter({ text: "Download the attached file and open it to read the full transcript." })
            .setTimestamp();

        try {
            await logChannel.send({ embeds: [logEmbed], files: [file] });
        } catch (error) {
            console.error("Could not post transcript:", error.message);
        }
    } else {
        console.error("Log channel not found - transcript not saved.");
    }

    delete ticketData.open[channel.id];
    saveTickets();

    setTimeout(() => {
        channel.delete().catch(err => console.error("Could not delete channel:", err.message));
    }, 5000);
}

// ================================
// INTERACTIONS
// ================================

client.on("interactionCreate", async interaction => {

    // ---------- game dropdown ----------
    if (interaction.isStringSelectMenu() && interaction.customId === "ticket_menu") {
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return createTicket(interaction, interaction.values[0]);
        } catch (error) {
            console.error("Menu error:", error);
            return;
        }
    }

    // ---------- buttons ----------
    if (interaction.isButton()) {
        try {
            if (interaction.customId.startsWith("ticket_create")) {
                // Older panels have no game suffix - treat those as "ow".
                const game = interaction.customId.split("_")[2] || "ow";
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                return createTicket(interaction, game);
            }

            if (interaction.customId === "ticket_close") {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                return closeTicket(interaction);
            }

        } catch (error) {
            console.error("Button error:", error);
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    // ---------- /reactionrole-list ----------
    if (interaction.commandName === "reactionrole-list") {
        if (reactionRoles.size === 0) {
            return interaction.reply({ content: "No reaction roles saved yet.", flags: MessageFlags.Ephemeral });
        }

        const lines = [...reactionRoles.entries()].map(([key, roleId]) => {
            const [messageId, emojiKey] = key.split(":");
            return `Message \`${messageId}\` - ${emojiKey} -> <@&${roleId}>`;
        });

        return interaction.reply({ content: lines.join("\n").slice(0, 1900), flags: MessageFlags.Ephemeral });
    }

    // ---------- /ticket-setup ----------
    if (interaction.commandName === "ticket-setup") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: "You need **Manage Server** to do this.", flags: MessageFlags.Ephemeral });
        }

        ticketData.config = {
            supportRoleId: interaction.options.getRole("support_role").id,
            logChannelId: interaction.options.getChannel("log_channel").id,
            categoryId: interaction.options.getChannel("category")?.id || null
        };

        // Running setup again wipes any per-game overrides so everything
        // falls back to the category above.
        ticketData.panels = {};

        saveTickets();

        return interaction.reply({
            content: "Ticket system configured. Now run **/ticket-panel** in the channel where customers should open tickets.",
            flags: MessageFlags.Ephemeral
        });
    }

    // ---------- /ticket-panel ----------
    if (interaction.commandName === "ticket-panel") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: "You need **Manage Server** to do this.", flags: MessageFlags.Ephemeral });
        }

        if (!ticketData.config.supportRoleId) {
            return interaction.reply({ content: "Run /ticket-setup first.", flags: MessageFlags.Ephemeral });
        }

        const game = interaction.options.getString("game");
        const gameName = GAMES[game] || game;

        ticketData.panels[game] = {
            categoryId: interaction.options.getChannel("category")?.id || null,
            supportRoleId: interaction.options.getRole("support_role")?.id || null
        };

        saveTickets();

        const embed = new EmbedBuilder()
            .setTitle(interaction.options.getString("title") || `${gameName} Support`)
            .setDescription(
                interaction.options.getString("description") ||
                `Need help with ${gameName}? Click the button below to open a private ticket with our staff.`
            )
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`ticket_create_${game}`)
                .setLabel("Create Ticket")
                .setEmoji("📩")
                .setStyle(ButtonStyle.Success)
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });

        return interaction.reply({
            content: `${gameName} panel posted. Tickets will be named \`ticket-${game}-username\`.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // ---------- /ticket-menu ----------
    if (interaction.commandName === "ticket-menu") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: "You need **Manage Server** to do this.", flags: MessageFlags.Ephemeral });
        }

        if (!ticketData.config.supportRoleId) {
            return interaction.reply({ content: "Run /ticket-setup first.", flags: MessageFlags.Ephemeral });
        }

        const categories = {
            wow: interaction.options.getChannel("wow_category")?.id || null,
            ow: interaction.options.getChannel("ow_category")?.id || null,
            lol: interaction.options.getChannel("lol_category")?.id || null
        };

        for (const [game, categoryId] of Object.entries(categories)) {
            ticketData.panels[game] = {
                categoryId: categoryId || ticketData.panels[game]?.categoryId || null,
                supportRoleId: ticketData.panels[game]?.supportRoleId || null
            };
        }

        saveTickets();

        function emojiText(name, fallback) {
            const found = interaction.guild.emojis.cache.find(
                e => e.name.toLowerCase() === name.toLowerCase()
            );
            return found ? found.toString() : fallback;
        }

        const embed = new EmbedBuilder()
            .setTitle(interaction.options.getString("title") || "Apply to Project Sylvanas")
            .setDescription(
                interaction.options.getString("description") ||
                "Pick the game you're applying for from the dropdown below. " +
                "A private channel will open where only you and our staff can talk.\n\n" +
                `${emojiText("PSWOW", "⚔️")} **PS WOW** - World of Warcraft\n` +
                `${emojiText("PSOW", "🎯")} **PS OW** - Overwatch\n` +
                `${emojiText("PSLOL", "🔮")} **PS LOL** - League of Legends\n\n` +
                "You can have one open ticket per game. Please have your details ready before applying."
            )
            .setTimestamp();

        // Look up your server emoji by name, fall back to a standard emoji.
        function findEmoji(name, fallback) {
            const found = interaction.guild.emojis.cache.find(
                e => e.name.toLowerCase() === name.toLowerCase()
            );
            return found ? { id: found.id, name: found.name, animated: found.animated } : fallback;
        }

        const menu = new StringSelectMenuBuilder()
            .setCustomId("ticket_menu")
            .setPlaceholder("Choose a game...")
            .addOptions(
                {
                    label: "PS WOW",
                    description: "Apply for World of Warcraft",
                    value: "wow",
                    emoji: findEmoji("PSWOW", "⚔️")
                },
                {
                    label: "PS OW",
                    description: "Apply for Overwatch",
                    value: "ow",
                    emoji: findEmoji("PSOW", "🎯")
                },
                {
                    label: "PS LOL",
                    description: "Apply for League of Legends",
                    value: "lol",
                    emoji: findEmoji("PSLOL", "🔮")
                }
            );

        await interaction.channel.send({
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(menu)]
        });

        return interaction.reply({ content: "Dropdown panel posted.", flags: MessageFlags.Ephemeral });
    }

    // ---------- /ticket-debug ----------
    if (interaction.commandName === "ticket-debug") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const me = await interaction.guild.members.fetchMe();
        const yes = v => (v ? "YES" : "NO");

        const lines = [];

        lines.push(`**My highest role:** ${me.roles.highest.name} (position ${me.roles.highest.position})`);
        lines.push("");
        lines.push("**Server-wide permissions**");
        lines.push(`Administrator: ${yes(me.permissions.has(PermissionFlagsBits.Administrator))}`);
        lines.push(`Manage Channels: ${yes(me.permissions.has(PermissionFlagsBits.ManageChannels))}`);
        lines.push(`Manage Roles: ${yes(me.permissions.has(PermissionFlagsBits.ManageRoles))}`);
        lines.push(`View Channels: ${yes(me.permissions.has(PermissionFlagsBits.ViewChannel))}`);
        lines.push(`Send Messages: ${yes(me.permissions.has(PermissionFlagsBits.SendMessages))}`);
        lines.push("");

        const categoryId = ticketData.config.categoryId;

        if (!categoryId) {
            lines.push("**Target category:** none set - tickets go to the top level of the server.");
        } else {
            const category = interaction.guild.channels.cache.get(categoryId);

            if (!category) {
                lines.push(`**Target category:** ID ${categoryId} - I CANNOT SEE THIS CHANNEL. It may have been deleted, or it is in another server.`);
            } else {
                const here = category.permissionsFor(me);
                lines.push(`**Target category:** ${category.name}`);
                lines.push(`Channels inside: ${category.children.cache.size} of 50`);
                lines.push(`View Channel here: ${yes(here.has(PermissionFlagsBits.ViewChannel))}`);
                lines.push(`Manage Channels here: ${yes(here.has(PermissionFlagsBits.ManageChannels))}`);
                lines.push(`Manage Roles here: ${yes(here.has(PermissionFlagsBits.ManageRoles))}`);
            }
        }

        lines.push("");

        const supportRoleId = ticketData.config.supportRoleId;
        const supportRole = supportRoleId ? interaction.guild.roles.cache.get(supportRoleId) : null;

        lines.push(`**Support role:** ${supportRole ? supportRole.name : "NOT SET or deleted"}`);

        const logChannel = ticketData.config.logChannelId
            ? interaction.guild.channels.cache.get(ticketData.config.logChannelId)
            : null;

        lines.push(`**Log channel:** ${logChannel ? `#${logChannel.name}` : "NOT SET or I can't see it"}`);
        lines.push(`**Per-game overrides:** ${Object.keys(ticketData.panels).length ? JSON.stringify(ticketData.panels) : "none"}`);
        lines.push(`**Data folder:** ${DATA_DIR}`);

        return interaction.editReply({ content: lines.join("\n").slice(0, 1900) });
    }

    // ---------- /ticket-close ----------
    if (interaction.commandName === "ticket-close") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return closeTicket(interaction);
    }

    // ---------- /reactionrole ----------
    if (interaction.commandName !== "reactionrole") return;

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
        return;
    }

    if (!interaction.guild) {
        return interaction.editReply({ content: "This command only works inside a server." });
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply({ content: "You need **Manage Roles** permission to use this command." });
    }

    const pairs = [];

    for (let i = 1; i <= MAX_PAIRS; i++) {
        const suffix = i === 1 ? "" : String(i);
        const emoji = interaction.options.getString(`emoji${suffix}`);
        const role = interaction.options.getRole(`role${suffix}`);

        if (emoji && role) {
            pairs.push({ emoji: emoji.trim(), role });
        } else if (emoji || role) {
            return interaction.editReply({
                content: `Pair ${i} is incomplete - you need both \`emoji${suffix}\` and \`role${suffix}\`.`
            });
        }
    }

    const seen = new Set();

    for (const pair of pairs) {
        const key = keyFromInput(pair.emoji);
        if (seen.has(key)) {
            return interaction.editReply({ content: `You used ${pair.emoji} more than once.` });
        }
        seen.add(key);
    }

    let me;

    try {
        me = await interaction.guild.members.fetchMe();
    } catch (error) {
        return interaction.editReply({ content: "I couldn't check my own permissions." });
    }

    for (const pair of pairs) {
        if (pair.role.position >= me.roles.highest.position) {
            return interaction.editReply({
                content: `I can't assign **${pair.role.name}** - it sits above my own role. Drag **${me.roles.highest.name}** above it in Server Settings > Roles.`
            });
        }

        if (pair.role.managed) {
            return interaction.editReply({ content: `**${pair.role.name}** is managed by an integration.` });
        }
    }

    const embed = new EmbedBuilder()
        .setTitle(interaction.options.getString("title") || "Reaction Roles")
        .setDescription(
            `${interaction.options.getString("description") || "React below to receive your role."}\n\n` +
            pairs.map(p => `${p.emoji} - ${p.role}`).join("\n")
        )
        .setTimestamp();

    let message;

    try {
        message = await interaction.channel.send({ embeds: [embed] });
    } catch (error) {
        return interaction.editReply({ content: "I couldn't post the message in this channel." });
    }

    for (const pair of pairs) {
        try {
            await message.react(pair.emoji);
        } catch (error) {
            await message.delete().catch(() => {});
            return interaction.editReply({ content: `I couldn't react with ${pair.emoji}.` });
        }
    }

    for (const pair of pairs) {
        reactionRoles.set(makeKey(message.id, keyFromInput(pair.emoji)), pair.role.id);
    }

    saveRoles();

    await interaction.editReply({
        content: `Reaction role message created with ${pairs.length} role${pairs.length === 1 ? "" : "s"}.`
    });
});

// ================================
// SAFETY NET
// ================================

client.on("error", error => console.error("Client error:", error));
process.on("unhandledRejection", error => console.error("Unhandled rejection:", error));

client.login(TOKEN);
