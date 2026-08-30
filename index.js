const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    SlashCommandBuilder,
    REST,
    Routes
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMessages
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction
    ]
});

// ================================
// CONFIG
// ================================

const reactionRoles = new Map();

// ================================
// BOT READY
// ================================

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);

    client.user.setPresence({
        activities: [
            {
                name: "Reaction Roles",
                type: 0
            }
        ],
        status: "online"
    });

    const commands = [
        new SlashCommandBuilder()
            .setName("reactionrole")
            .setDescription("Create a reaction role message")
            .addStringOption(option =>
                option
                    .setName("emoji")
                    .setDescription("Emoji users react with")
                    .setRequired(true)
            )
            .addRoleOption(option =>
                option
                    .setName("role")
                    .setDescription("Role to give")
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
            )
    ].map(command => command.toJSON());

    const rest = new REST({ version: "10" }).setToken(TOKEN);

    try {
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands }
        );

        console.log("Slash commands registered.");
    } catch (error) {
        console.error(error);
    }
});

// ================================
// REACTION ADDED
// ================================

client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch {
            return;
        }
    }

    const key = `${reaction.message.id}:${reaction.emoji.identifier}`;

    const roleId = reactionRoles.get(key);

    if (!roleId) return;

    const member = await reaction.message.guild.members.fetch(user.id);

    try {
        await member.roles.add(roleId);
    } catch (error) {
        console.error("Couldn't add role:", error);
    }
});

// ================================
// REACTION REMOVED
// ================================

client.on("messageReactionRemove", async (reaction, user) => {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch {
            return;
        }
    }

    const key = `${reaction.message.id}:${reaction.emoji.identifier}`;

    const roleId = reactionRoles.get(key);

    if (!roleId) return;

    const member = await reaction.message.guild.members.fetch(user.id);

    try {
        await member.roles.remove(roleId);
    } catch (error) {
        console.error("Couldn't remove role:", error);
    }
});

// ================================
// SLASH COMMAND
// ================================

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName !== "reactionrole") return;

    if (!interaction.member.permissions.has("ManageRoles")) {
        return interaction.reply({
            content: "❌ You need **Manage Roles** permission to use this command.",
            ephemeral: true
        });
    }

    const emoji = interaction.options.getString("emoji");
    const role = interaction.options.getRole("role");

    const title =
        interaction.options.getString("title") ||
        "Reaction Roles";

    const description =
        interaction.options.getString("description") ||
        "React below to receive your role.";

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(`${description}\n\n${emoji} → ${role}`)
        .setTimestamp();

    const message = await interaction.channel.send({
        embeds: [embed]
    });

    try {
        await message.react(emoji);
    } catch {
        return interaction.reply({
            content: "❌ I couldn't react with that emoji.",
            ephemeral: true
        });
    }

    const key = `${message.id}:${emoji}`;

    reactionRoles.set(key, role.id);

    await interaction.reply({
        content: "✅ Reaction role created!",
        ephemeral: true
    });
});

// ================================
// LOGIN
// ================================

client.login(TOKEN);
