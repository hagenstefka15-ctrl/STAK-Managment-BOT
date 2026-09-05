require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    ChannelType,
    PermissionFlagsBits,
    AuditLogEvent,
    RoleSelectMenuBuilder,
    ChannelSelectMenuBuilder
} = require('discord.js');

const fs = require('fs');
const path = require('path');

// ========================================
// CONFIG
// ========================================

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

const DATA_FILE = path.join(__dirname, 'stak-data.json');
const BACKUP_FILE = path.join(__dirname, 'stak-data.backup.json');

const PLAYERS_PER_PAGE = 25;
const CASES_PER_PAGE = 25;

// ========================================
// DATABASE
// ========================================

let data = {
    staff: {},
    players: {},
    nextCaseNumber: 1,

    activityPanelChannelId: null,
    activityPanelMessageId: null,

    casePanelChannelId: null,
    casePanelMessageId: null,

    // Next Gen systems
    config: {
        logger: { modChannelId: null, auditChannelId: null, communityChannelId: null },
        honeypot: { channelId: null, enabled: false, panelMessageId: null },
        roles: { communityRoleId: null, botRoleId: null },
        booster: { channelId: null, enabled: false },
        giveaway: { allowedRoleIds: [] },
        youtube: { template: '{channel} just posted a new video\n**{title}**\n[Watch the video]({url})', defaultPingRoleId: null, channels: {} }
    },
    giveaways: {}
};

if (fs.existsSync(DATA_FILE)) {
    try {
        const saved = JSON.parse(
            fs.readFileSync(DATA_FILE, 'utf8')
        );

        data = {
            ...data,
            ...saved,
            staff: saved.staff || {},
            players: saved.players || {},
            nextCaseNumber: saved.nextCaseNumber || 1,
            config: {
                logger: { modChannelId: null, auditChannelId: null, communityChannelId: null, ...(saved.config?.logger || {}) },
                honeypot: { channelId: null, enabled: false, panelMessageId: null, ...(saved.config?.honeypot || {}) },
                roles: { communityRoleId: null, botRoleId: null, ...(saved.config?.roles || {}) },
                booster: { channelId: null, enabled: false, ...(saved.config?.booster || {}) },
                giveaway: { allowedRoleIds: [], ...(saved.config?.giveaway || {}) },
                youtube: { template: '{channel} just posted a new video\n**{title}**\n[Watch the video]({url})', defaultPingRoleId: null, channels: {}, ...(saved.config?.youtube || {}) }
            },
            giveaways: saved.giveaways || {}
        };
    } catch (error) {
        console.log('Could not load stak-data.json.');
    }
}

function saveData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            fs.copyFileSync(DATA_FILE, BACKUP_FILE);
        }

        const tempFile = `${DATA_FILE}.tmp`;
        fs.writeFileSync(
            tempFile,
            JSON.stringify(data, null, 2),
            'utf8'
        );
        fs.renameSync(tempFile, DATA_FILE);
    } catch (error) {
        console.error('Could not save STAK data:', error);
    }
}

function isAdministrator(interaction) {
    return interaction.memberPermissions?.has('Administrator') === true;
}

function canEditCase(interaction, selectedCase) {
    return isAdministrator(interaction) || selectedCase.createdById === interaction.user.id;
}

// ========================================
// CLIENT
// ========================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildExpressions,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildInvites
    ]
});

// ========================================
// COMMANDS
// ========================================

const commands = [

    new SlashCommandBuilder()
        .setName('staffpanel')
        .setDescription('Create the Staff Status Panel.'),

    new SlashCommandBuilder()
        .setName('showstats')
        .setDescription('Show staff administration statistics.')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('Select a staff member.')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('casepanel')
        .setDescription('Create the Staff Case Management Panel.'),

    new SlashCommandBuilder()
        .setName('management')
        .setDescription('Open the STAK Management dashboard.'),

    new SlashCommandBuilder()
        .setName('backup')
        .setDescription('Manage STAK server backups.')
        .addSubcommand(sub => sub.setName('create').setDescription('Create a full server backup snapshot.'))
        .addSubcommand(sub => sub.setName('list').setDescription('List available backup snapshots.'))
        .addSubcommand(sub => sub.setName('restore').setDescription('Restore a backup snapshot by ID.')
            .addStringOption(o => o.setName('id').setDescription('Backup ID.').setRequired(true))),

    new SlashCommandBuilder()
        .setName('logger')
        .setDescription('Configure STAK logging channels.')
        .addSubcommand(sub => sub.setName('set').setDescription('Set a logging channel.')
            .addStringOption(o => o.setName('type').setDescription('Log type.').setRequired(true).addChoices(
                { name: 'Mod Logs', value: 'mod' },
                { name: 'Audit Logs', value: 'audit' },
                { name: 'Community Logs', value: 'community' }
            ))
            .addChannelOption(o => o.setName('channel').setDescription('Target text channel.').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand(sub => sub.setName('show').setDescription('Show current logger settings.')),

    new SlashCommandBuilder()
        .setName('honeypot')
        .setDescription('Configure the STAK Honeypot.')
        .addSubcommand(sub => sub.setName('setup').setDescription('Set up the honeypot channel.')
            .addChannelOption(o => o.setName('channel').setDescription('Honeypot text channel.').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand(sub => sub.setName('disable').setDescription('Disable the honeypot.')),

    new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Create a simple STAK giveaway.'),

    new SlashCommandBuilder()
        .setName('giveaway-access')
        .setDescription('Configure which roles may create giveaways.')
        .addRoleOption(o => o.setName('role').setDescription('Role to toggle.').setRequired(true)),

    new SlashCommandBuilder()
        .setName('youtube')
        .setDescription('Configure YouTube notifications.')
        .addSubcommand(sub => sub.setName('add').setDescription('Add a YouTube channel notification.')
            .addStringOption(o => o.setName('channel_id').setDescription('YouTube channel ID.').setRequired(true))
            .addChannelOption(o => o.setName('target').setDescription('Discord target channel.').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addRoleOption(o => o.setName('ping_role').setDescription('Optional role to mention.')))
        .addSubcommand(sub => sub.setName('remove').setDescription('Remove a YouTube channel notification.')
            .addStringOption(o => o.setName('channel_id').setDescription('YouTube channel ID.').setRequired(true)))
        .addSubcommand(sub => sub.setName('list').setDescription('List configured YouTube notifications.'))
        .addSubcommand(sub => sub.setName('template').setDescription('Set the YouTube message template.')),

    new SlashCommandBuilder()
        .setName('booster')
        .setDescription('Configure booster messages.')
        .addSubcommand(sub => sub.setName('set-channel').setDescription('Set the booster message channel.')
            .addChannelOption(o => o.setName('channel').setDescription('Target text channel.').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand(sub => sub.setName('disable').setDescription('Disable booster messages.')),

    new SlashCommandBuilder()
        .setName('roles')
        .setDescription('Configure automatic STAK roles.')
        .addSubcommand(sub => sub.setName('community').setDescription('Set the automatic Community Member role.')
            .addRoleOption(o => o.setName('role').setDescription('Community Member role.').setRequired(true)))
        .addSubcommand(sub => sub.setName('bot').setDescription('Set the protected Bot role.')
            .addRoleOption(o => o.setName('role').setDescription('Bot role.').setRequired(true)))

].map(command => command.toJSON());

// ========================================
// TIME
// ========================================

function formatTime(milliseconds) {

    if (!milliseconds || milliseconds < 0) {
        return '0h 0m';
    }

    const totalMinutes =
        Math.floor(milliseconds / 60000);

    const hours =
        Math.floor(totalMinutes / 60);

    const minutes =
        totalMinutes % 60;

    return `${hours}h ${minutes}m`;
}

function dateKey() {
    return new Date()
        .toISOString()
        .split('T')[0];
}

function weekKey() {

    const date = new Date();

    const day = date.getDay();

    const diff =
        date.getDate() -
        day +
        (day === 0 ? -6 : 1);

    date.setDate(diff);

    return date
        .toISOString()
        .split('T')[0];
}

function monthKey() {

    const date = new Date();

    return `${date.getFullYear()}-${String(
        date.getMonth() + 1
    ).padStart(2, '0')}`;
}

// ========================================
// STAFF DATA
// ========================================

function getStaff(userId) {

    if (!data.staff[userId]) {

        data.staff[userId] = {
            inDuty: false,
            onBreak: false,
            shiftStart: null,
            daily: {},
            weekly: {},
            monthly: {},
            shifts: 0
        };

        saveData();
    }

    return data.staff[userId];
}

function currentShift(staff) {

    if (
        !staff.inDuty ||
        staff.onBreak ||
        !staff.shiftStart
    ) {
        return 0;
    }

    return Date.now() - staff.shiftStart;
}

function saveCurrentShift(userId) {

    const staff = getStaff(userId);

    if (
        !staff.inDuty ||
        staff.onBreak ||
        !staff.shiftStart
    ) {
        return;
    }

    const elapsed =
        Date.now() - staff.shiftStart;

    const today = dateKey();
    const week = weekKey();
    const month = monthKey();

    staff.daily[today] =
        (staff.daily[today] || 0) + elapsed;

    staff.weekly[week] =
        (staff.weekly[week] || 0) + elapsed;

    staff.monthly[month] =
        (staff.monthly[month] || 0) + elapsed;

    staff.shiftStart = Date.now();

    saveData();
}

function activeStaff() {

    return Object.entries(data.staff)
        .filter(([_, staff]) =>
            staff.inDuty &&
            !staff.onBreak
        );
}

// ========================================
// STAFF PANEL
// ========================================

function staffPanelEmbed() {

    const active = activeStaff();

    let list = '';

    if (active.length === 0) {

        list =
            '🔴 **No staff members are currently In Duty.**';

    } else {

        for (const [userId, staff] of active) {

            list +=
                `🟢 <@${userId}> — **${formatTime(
                    currentShift(staff)
                )}**\n`;
        }
    }

    const status =
        active.length >= 3
            ? `🟢 **${active.length} Staff In Duty**`
            : `🔴 **${active.length}/3 Staff In Duty**`;

    return new EmbedBuilder()

        .setTitle('🛡️ STAK | Staff Status')

        .setDescription(
            `### Administration Status\n` +
            `${status}\n\n` +
            `### Currently In Duty\n` +
            `${list}\n\n` +
            `Use the buttons below to manage your administration status.`
        )

        .setFooter({
            text: 'STAK • No One Stands Alone'
        })

        .setTimestamp();
}

function staffButtons() {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId('staff_in')
                .setLabel('Go In Duty')
                .setEmoji('🟢')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('staff_break')
                .setLabel('Break')
                .setEmoji('⏸️')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId('staff_out')
                .setLabel('Go Out Duty')
                .setEmoji('🔴')
                .setStyle(ButtonStyle.Danger)
        );
}

// ========================================
// CASE PANEL
// ========================================

function casePanelEmbed() {

    return new EmbedBuilder()

        .setTitle('📁 STAK | Case Management')

        .setDescription(
            '**Player Records & Case Management**\n\n' +

            'Create, search and manage player records and their cases.\n\n' +

            `📁 **Create Player Record**\n` +
            `Create a new player record. Existing players cannot be duplicated.\n\n` +

            `🔎 **Search Player**\n` +
            `Find an existing player record.\n\n` +

            `✏️ **Edit Case**\n` +
            `Find a player and edit one of their existing cases.\n\n` +

            `All actions and search results are private to the staff member using them.`
        )

        .setFooter({
            text: 'STAK Case Management • No One Stands Alone'
        });
}

function casePanelButtons() {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId('case_create')
                .setLabel('Create Player Record')
                .setEmoji('📁')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('case_search')
                .setLabel('Search Player')
                .setEmoji('🔎')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId('case_edit')
                .setLabel('Edit Case')
                .setEmoji('✏️')
                .setStyle(ButtonStyle.Secondary)
        );
}

// ========================================
// CASE NUMBER
// ========================================

function generateCaseNumber() {

    const number =
        data.nextCaseNumber++;

    saveData();

    return `STAK-${String(number).padStart(4, '0')}`;
}

// ========================================
// PLAYER HELPERS
// ========================================

function playerKey(ingameUsername, discordUsername) {

    return `${ingameUsername.toLowerCase()}::${discordUsername.toLowerCase()}`;
}

function getAllPlayers() {

    return Object.entries(data.players)
        .map(([id, player]) => ({
            id,
            player
        }))
        .sort((a, b) =>
            a.player.ingameUsername
                .localeCompare(
                    b.player.ingameUsername,
                    undefined,
                    {
                        sensitivity: 'base'
                    }
                )
        );
}

function searchPlayers(search) {

    const value =
        search.trim().toLowerCase();

    return getAllPlayers()
        .filter(({ player }) => {

            if (!value) {
                return true;
            }

            return (
                player.ingameUsername
                    ?.toLowerCase()
                    .includes(value)
                ||
                player.discordUsername
                    ?.toLowerCase()
                    .includes(value)
            );
        });
}

// ========================================
// PLAYER EMBED
// ========================================

function playerEmbed(player) {

    let cases = '';

    if (
        !player.cases ||
        player.cases.length === 0
    ) {

        cases =
            'No cases recorded yet.';

    } else {

        const recentCases =
            player.cases.slice(-10).reverse();

        for (const item of recentCases) {

            cases +=
                `**${item.caseNumber}** • **${item.type}** • ${item.game}\n` +
                `Action: ${item.action}\n` +
                `Reason: ${item.reason}\n` +
                `Date: ${item.date}\n\n`;
        }

        if (player.cases.length > 10) {

            cases +=
                `*Showing latest 10 of ${player.cases.length} cases.*`;
        }
    }

    return new EmbedBuilder()

        .setTitle(
            `📁 Player Record | ${player.ingameUsername}`
        )

        .setDescription(

            `### General Information\n` +

            `**In-Game Username:** ${player.ingameUsername}\n` +

            `**Discord Username:** ${player.discordUsername}\n` +

            `**Discord ID:** ${player.discordId || 'Not linked'}\n` +

            `**Record Created:** ${player.createdAt}\n` +

            `**Total Cases:** ${player.cases?.length || 0}\n\n` +

            `### Case History\n` +

            cases
        )

        .setFooter({
            text: 'STAK Player Record'
        });
}

// ========================================
// PLAYER RECORD BUTTONS
// ========================================

function playerRecordButtons(playerId) {

    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId(`player_add_${playerId}`)
                .setLabel('Add Case')
                .setEmoji('➕')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId(`player_edit_${playerId}`)
                .setLabel('Edit Case')
                .setEmoji('✏️')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId(`player_delete_${playerId}`)
                .setLabel('Delete Case')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger),

            new ButtonBuilder()
                .setCustomId('player_close')
                .setLabel('Close')
                .setEmoji('✖️')
                .setStyle(ButtonStyle.Secondary)
        );
}

// ========================================
// CREATE PLAYER MODAL
// ========================================

function createPlayerModal() {

    return new ModalBuilder()

        .setCustomId('create_player_modal')

        .setTitle('Create Player Record')

        .addComponents(

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('ingame_username')
                    .setLabel('In-Game Username')
                    .setPlaceholder('Enter the player name')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(100)
            ),

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('discord_username')
                    .setLabel('Discord Username')
                    .setPlaceholder('Enter the Discord username')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(100)
            ),

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('notes')
                    .setLabel('Initial Notes')
                    .setPlaceholder('Optional')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(1000)
            )
        );
}

// ========================================
// ADD CASE MODAL
// ========================================

function addCaseModal(playerId) {

    return new ModalBuilder()

        .setCustomId(`add_case_${playerId}`)

        .setTitle('Add New Case')

        .addComponents(

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('game')
                    .setLabel('Game / Server')
                    .setPlaceholder('Roblox / Armory Forge / Ready or Not')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(100)
            ),

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('type')
                    .setLabel('Case Type')
                    .setPlaceholder('Warning / Kick / Ban / Note / Other')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(50)
            ),

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('action')
                    .setLabel('Action / Outcome')
                    .setPlaceholder('What action was taken?')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(500)
            ),

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Reason')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1500)
            ),

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('notes')
                    .setLabel('Duration / Evidence / Notes')
                    .setPlaceholder('Ban duration, evidence, additional notes...')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(1500)
            )
        );
}

// ========================================
// EDIT CASE MODAL
// ========================================

function editCaseModal(playerId, caseNumber) {

    const player =
        data.players[playerId];

    const currentCase =
        player.cases.find(
            item =>
                item.caseNumber === caseNumber
        );

    return new ModalBuilder()

        .setCustomId(
            `edit_case_${playerId}_${caseNumber}`
        )

        .setTitle(`Edit ${caseNumber}`)

        .addComponents(

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('game')
                    .setLabel('Game / Server')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(currentCase.game || '')
            ),

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('type')
                    .setLabel('Case Type')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(currentCase.type || '')
            ),

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('action')
                    .setLabel('Action / Outcome')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(currentCase.action || '')
            ),

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Reason')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setValue(currentCase.reason || '')
            ),

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('notes')
                    .setLabel('Duration / Evidence / Notes')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setValue(currentCase.notes || '')
            )
        );
}

// ========================================
// CASE SELECT MENU
// ========================================

function caseSelectMenu(playerId, page = 0) {

    const player =
        data.players[playerId];

    const cases =
        player.cases || [];

    const start =
        page * CASES_PER_PAGE;

    const pageCases =
        cases.slice(start, start + CASES_PER_PAGE);

    const menu =
        new StringSelectMenuBuilder()

            .setCustomId(
                `select_case_${playerId}_${page}`
            )

            .setPlaceholder(
                'Select a case to edit'
            )

            .addOptions(
                pageCases.map(item => ({

                    label:
                        `${item.caseNumber} • ${item.type}`
                            .slice(0, 100),

                    description:
                        `${item.game} • ${item.reason}`
                            .slice(0, 100),

                    value:
                        item.caseNumber

                }))
            );

    return menu;
}

function deleteCaseSelectMenu(playerId) {
    const player = data.players[playerId];
    const cases = player?.cases || [];

    return new StringSelectMenuBuilder()
        .setCustomId(`select_delete_case_${playerId}`)
        .setPlaceholder('Select a case to delete')
        .addOptions(
            cases.slice(0, 25).map(item => ({
                label: `${item.caseNumber} • ${item.type}`.slice(0, 100),
                description: `${item.game} • ${item.reason}`.slice(0, 100),
                value: item.caseNumber
            }))
        );
}

// ========================================
// PLAYER SELECT MENU
// ========================================

function playerSelectMenu(
    players,
    page,
    mode
) {

    const start =
        page * PLAYERS_PER_PAGE;

    const pagePlayers =
        players.slice(
            start,
            start + PLAYERS_PER_PAGE
        );

    const menu =
        new StringSelectMenuBuilder()

            .setCustomId(
                `select_player_${mode}_${page}`
            )

            .setPlaceholder(
                'Select a player'
            )

            .addOptions(

                pagePlayers.map(({ id, player }) => ({

                    label:
                        player.ingameUsername
                            .slice(0, 100),

                    description:
                        `${player.discordUsername} • ${player.cases?.length || 0} Cases`
                            .slice(0, 100),

                    value:
                        id

                }))

            );

    return menu;
}

// ========================================
// PLAYER PAGINATION
// ========================================

function playerNavigation(
    page,
    totalPages,
    mode
) {

    const row =
        new ActionRowBuilder();

    if (page > 0) {

        row.addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `player_prev_${mode}_${page - 1}`
                )
                .setLabel('Previous')
                .setEmoji('◀️')
                .setStyle(ButtonStyle.Secondary)

        );
    }

    row.addComponents(

        new ButtonBuilder()
            .setCustomId('player_close')
            .setLabel('Close')
            .setEmoji('✖️')
            .setStyle(ButtonStyle.Danger)

    );

    if (page < totalPages - 1) {

        row.addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `player_next_${mode}_${page + 1}`
                )
                .setLabel('Next')
                .setEmoji('▶️')
                .setStyle(ButtonStyle.Secondary)

        );
    }

    return row;
}

// ========================================
// SEARCH MODAL
// ========================================

function searchPlayerModal(mode) {

    return new ModalBuilder()

        .setCustomId(
            `search_player_${mode}`
        )

        .setTitle(
            mode === 'edit'
                ? 'Find Player to Edit'
                : 'Search Player'
        )

        .addComponents(

            new ActionRowBuilder().addComponents(

                new TextInputBuilder()
                    .setCustomId('search')
                    .setLabel('Player Name')
                    .setPlaceholder(
                        'Leave empty to browse all players'
                    )
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(100)

            )
        );
}

// ========================================
// READY
// ========================================

client.once('clientReady', async () => {

    console.log(
        `STAK Bot ist online als ${client.user.tag}`
    );

    await registerCommands();

    console.log(
        'STAK Staff + Case System loaded.'
    );

    setInterval(
        updateStaffPanel,
        30000
    );
});

// ========================================
// REGISTER COMMANDS
// ========================================

async function registerCommands() {

    if (!GUILD_ID) {

        console.log(
            'ERROR: GUILD_ID missing from .env'
        );

        return;
    }

    const rest =
        new REST({ version: '10' })
            .setToken(TOKEN);

    try {

        await rest.put(

            Routes.applicationGuildCommands(
                client.user.id,
                GUILD_ID
            ),

            {
                body: commands
            }

        );

        console.log(
            'STAK commands registered successfully.'
        );

    } catch (error) {

        console.error(
            'Command registration error:',
            error
        );
    }
}

// ========================================
// STAFF PANEL UPDATE
// ========================================

async function updateStaffPanel() {

    if (
        !data.activityPanelChannelId ||
        !data.activityPanelMessageId
    ) {
        return;
    }

    try {

        const channel =
            await client.channels.fetch(
                data.activityPanelChannelId
            );

        const message =
            await channel.messages.fetch(
                data.activityPanelMessageId
            );

        await message.edit({

            embeds: [
                staffPanelEmbed()
            ],

            components: [
                staffButtons()
            ]

        });

    } catch (error) {

        console.log(
            'Could not update staff panel.'
        );
    }
}

// ========================================
// ALL INTERACTIONS
// ========================================

client.on(
    'interactionCreate',
    async interaction => {

        // ==================================
        // SLASH COMMANDS
        // ==================================

        if (interaction.isChatInputCommand()) {

            // -------------------------------
            // STAFF PANEL
            // -------------------------------

            if (
                interaction.commandName ===
                'staffpanel'
            ) {

                const message =
                    await interaction.channel.send({

                        embeds: [
                            staffPanelEmbed()
                        ],

                        components: [
                            staffButtons()
                        ]

                    });

                data.activityPanelChannelId =
                    interaction.channel.id;

                data.activityPanelMessageId =
                    message.id;

                saveData();

                await interaction.reply({

                    content:
                        '✅ Staff Status Panel created.',

                    ephemeral: true

                });

                return;
            }

            // -------------------------------
            // SHOW STATS
            // -------------------------------

            if (
                interaction.commandName ===
                'showstats'
            ) {

                const user =
                    interaction.options.getUser(
                        'user'
                    );

                const staff =
                    getStaff(user.id);

                const today =
                    dateKey();

                const week =
                    weekKey();

                const month =
                    monthKey();

                let todayTime =
                    staff.daily[today] || 0;

                let weekTime =
                    staff.weekly[week] || 0;

                let monthTime =
                    staff.monthly[month] || 0;

                const current =
                    currentShift(staff);

                if (
                    staff.inDuty &&
                    !staff.onBreak
                ) {

                    todayTime += current;
                    weekTime += current;
                    monthTime += current;
                }

                const embed =
                    new EmbedBuilder()

                        .setTitle(
                            `📊 Staff Statistics | ${user.username}`
                        )

                        .setDescription(

                            `### Today\n` +
                            `**${formatTime(todayTime)}**\n\n` +

                            `### This Week\n` +
                            `**${formatTime(weekTime)}**\n\n` +

                            `### This Month\n` +
                            `**${formatTime(monthTime)}**\n\n` +

                            `### Total Shifts\n` +
                            `**${staff.shifts}**`

                        );

                await interaction.reply({

                    embeds: [embed],

                    ephemeral: true

                });

                return;
            }

            // -------------------------------
            // CASE PANEL
            // -------------------------------

            if (
                interaction.commandName ===
                'casepanel'
            ) {

                const message =
                    await interaction.channel.send({

                        embeds: [
                            casePanelEmbed()
                        ],

                        components: [
                            casePanelButtons()
                        ]

                    });

                data.casePanelChannelId =
                    interaction.channel.id;

                data.casePanelMessageId =
                    message.id;

                saveData();

                await interaction.reply({

                    content:
                        '✅ Case Management Panel created.',

                    ephemeral: true

                });

                return;
            }
        }

        // ==================================
        // STAFF BUTTONS
        // ==================================

        if (
            interaction.isButton() &&
            [
                'staff_in',
                'staff_break',
                'staff_out'
            ].includes(
                interaction.customId
            )
        ) {

            const userId =
                interaction.user.id;

            const staff =
                getStaff(userId);

            // GO IN DUTY
            if (
                interaction.customId ===
                'staff_in'
            ) {

                if (staff.inDuty) {

                    return interaction.reply({

                        content:
                            '⚠️ You are already **In Duty**.',

                        ephemeral: true

                    });
                }

                staff.inDuty = true;
                staff.onBreak = false;
                staff.shiftStart = Date.now();
                staff.shifts++;

                saveData();

                await interaction.update({

                    embeds: [
                        staffPanelEmbed()
                    ],

                    components: [
                        staffButtons()
                    ]

                });

                await interaction.followUp({

                    content:
                        '🟢 **You are now In Duty.**\nYour administration time is being tracked.',

                    ephemeral: true

                });

                return;
            }

            // BREAK
            if (
                interaction.customId ===
                'staff_break'
            ) {

                if (!staff.inDuty) {

                    return interaction.reply({

                        content:
                            '⚠️ You are not currently In Duty.',

                        ephemeral: true

                    });
                }

                if (staff.onBreak) {

                    return interaction.reply({

                        content:
                            '⚠️ You are already on Break.',

                        ephemeral: true

                    });
                }

                saveCurrentShift(userId);

                staff.onBreak = true;
                staff.shiftStart = null;

                saveData();

                await interaction.update({

                    embeds: [
                        staffPanelEmbed()
                    ],

                    components: [
                        staffButtons()
                    ]

                });

                await interaction.followUp({

                    content:
                        '⏸️ **You are now on Break.**\nYour administration time is paused.',

                    ephemeral: true

                });

                return;
            }

            // GO OUT DUTY
            if (
                interaction.customId ===
                'staff_out'
            ) {

                if (!staff.inDuty) {

                    return interaction.reply({

                        content:
                            '⚠️ You are already **Out Duty**.',

                        ephemeral: true

                    });
                }

                saveCurrentShift(userId);

                staff.inDuty = false;
                staff.onBreak = false;
                staff.shiftStart = null;

                saveData();

                await interaction.update({

                    embeds: [
                        staffPanelEmbed()
                    ],

                    components: [
                        staffButtons()
                    ]

                });

                await interaction.followUp({

                    content:
                        '🔴 **You are now Out Duty.**\nYour administration shift has been saved.',

                    ephemeral: true

                });

                return;
            }
        }

        // ==================================
        // CASE CREATE
        // ==================================

        if (
            interaction.isButton() &&
            interaction.customId ===
            'case_create'
        ) {

            await interaction.showModal(
                createPlayerModal()
            );

            return;
        }

        // ==================================
        // CASE SEARCH
        // ==================================

        if (
            interaction.isButton() &&
            interaction.customId ===
            'case_search'
        ) {

            await interaction.showModal(
                searchPlayerModal('search')
            );

            return;
        }

        // ==================================
        // CASE EDIT
        // ==================================

        if (
            interaction.isButton() &&
            interaction.customId ===
            'case_edit'
        ) {

            await interaction.showModal(
                searchPlayerModal('edit')
            );

            return;
        }

        // ==================================
        // CREATE PLAYER MODAL
        // ==================================

        if (
            interaction.isModalSubmit() &&
            interaction.customId ===
            'create_player_modal'
        ) {

            const ingame =
                interaction.fields.getTextInputValue(
                    'ingame_username'
                )
                .trim();

            const discordUsername =
                interaction.fields.getTextInputValue(
                    'discord_username'
                )
                .trim();

            const notes =
                interaction.fields.getTextInputValue(
                    'notes'
                )
                .trim();

            const key =
                playerKey(
                    ingame,
                    discordUsername
                );

            // Existing player
            if (data.players[key]) {

                const existing =
                    data.players[key];

                await interaction.reply({

                    content:
                        '⚠️ **This player record already exists.**\n\n' +
                        'Use **Add Case** on the existing player record instead of creating a duplicate.',

                    embeds: [
                        playerEmbed(existing)
                    ],

                    components: [
                        playerRecordButtons(key)
                    ],

                    ephemeral: true

                });

                return;
            }

            // Try automatic Discord ID lookup
            let discordId = 'Not linked';

            try {

                const members =
                    await interaction.guild.members.search({

                        query:
                            discordUsername,

                        limit: 25

                    });

                const exact =
                    members.find(member =>

                        member.user.username
                            .toLowerCase() ===
                        discordUsername
                            .toLowerCase()

                        ||

                        member.user.globalName
                            ?.toLowerCase() ===
                        discordUsername
                            .toLowerCase()

                        ||

                        member.displayName
                            .toLowerCase() ===
                        discordUsername
                            .toLowerCase()

                    );

                if (exact) {

                    discordId =
                        exact.user.id;
                }

            } catch {
                discordId = 'Not linked';
            }

            data.players[key] = {

                ingameUsername: ingame,

                discordUsername,

                discordId,

                createdAt:
                    new Date().toLocaleString(
                        'en-GB'
                    ),

                notes,

                cases: []

            };

            saveData();

            await interaction.reply({

                content:
                    '✅ **Player record created successfully.**\n\n' +
                    'You can now add cases to this player.',

                embeds: [
                    playerEmbed(
                        data.players[key]
                    )
                ],

                components: [
                    playerRecordButtons(key)
                ],

                ephemeral: true

            });

            return;
        }

        // ==================================
        // SEARCH PLAYER MODAL
        // ==================================

        if (
            interaction.isModalSubmit() &&
            (
                interaction.customId ===
                'search_player_search'
                ||
                interaction.customId ===
                'search_player_edit'
            )
        ) {

            const mode =
                interaction.customId.endsWith(
                    '_edit'
                )
                    ? 'edit'
                    : 'search';

            const search =
                interaction.fields.getTextInputValue(
                    'search'
                )
                .trim();

            const players =
                searchPlayers(search);

            if (players.length === 0) {

                await interaction.reply({

                    content:
                        '❌ No player records found.',

                    ephemeral: true

                });

                return;
            }

            const totalPages =
                Math.ceil(
                    players.length /
                    PLAYERS_PER_PAGE
                );

            const page = 0;

            await interaction.reply({

                content:
                    `🔎 **Player Search**\n` +
                    `Found **${players.length}** player record(s).\n` +
                    `Page **1/${totalPages}**`,

                components: [

                    new ActionRowBuilder()
                        .addComponents(
                            playerSelectMenu(
                                players,
                                page,
                                mode
                            )
                        ),

                    playerNavigation(
                        page,
                        totalPages,
                        mode
                    )

                ],

                ephemeral: true

            });

            return;
        }

        // ==================================
        // PLAYER NAVIGATION
        // ==================================

        if (
            interaction.isButton() &&
            (
                interaction.customId.startsWith(
                    'player_prev_'
                )
                ||
                interaction.customId.startsWith(
                    'player_next_'
                )
            )
        ) {

            const parts =
                interaction.customId.split('_');

            const mode =
                parts[2];

            const page =
                Number(parts[3]);

            const players =
                getAllPlayers();

            const totalPages =
                Math.ceil(
                    players.length /
                    PLAYERS_PER_PAGE
                );

            await interaction.update({

                content:
                    `🔎 **Player Search**\n` +
                    `Found **${players.length}** player record(s).\n` +
                    `Page **${page + 1}/${totalPages}**`,

                components: [

                    new ActionRowBuilder()
                        .addComponents(
                            playerSelectMenu(
                                players,
                                page,
                                mode
                            )
                        ),

                    playerNavigation(
                        page,
                        totalPages,
                        mode
                    )

                ]

            });

            return;
        }

        // ==================================
        // SELECT PLAYER
        // ==================================

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId.startsWith(
                'select_player_'
            )
        ) {

            const parts =
                interaction.customId.split('_');

            const mode =
                parts[2];

            const playerId =
                interaction.values[0];

            const player =
                data.players[playerId];

            if (!player) {

                return interaction.update({

                    content:
                        '❌ Player not found.',

                    components: []

                });
            }

            if (mode === 'edit') {

                if (
                    !player.cases ||
                    player.cases.length === 0
                ) {

                    return interaction.update({

                        content:
                            '❌ This player has no cases to edit.',

                        embeds: [
                            playerEmbed(player)
                        ],

                        components: [
                            playerRecordButtons(
                                playerId
                            )
                        ]

                    });
                }

                const totalPages =
                    Math.ceil(
                        player.cases.length /
                        CASES_PER_PAGE
                    );

                await interaction.update({

                    content:
                        `✏️ **Select a Case to Edit**\n` +
                        `Player: **${player.ingameUsername}**\n` +
                        `Page **1/${totalPages}**`,

                    embeds: [
                        playerEmbed(player)
                    ],

                    components: [

                        new ActionRowBuilder()
                            .addComponents(
                                caseSelectMenu(
                                    playerId,
                                    0
                                )
                            ),

                        new ActionRowBuilder()
                            .addComponents(

                                new ButtonBuilder()
                                    .setCustomId(
                                        `player_add_${playerId}`
                                    )
                                    .setLabel(
                                        'Add Case'
                                    )
                                    .setEmoji('➕')
                                    .setStyle(
                                        ButtonStyle.Success
                                    ),

                                new ButtonBuilder()
                                    .setCustomId(
                                        'player_close'
                                    )
                                    .setLabel(
                                        'Close'
                                    )
                                    .setEmoji('✖️')
                                    .setStyle(
                                        ButtonStyle.Danger
                                    )
                            )

                    ]

                });

                return;
            }

            await interaction.update({

                content: '',

                embeds: [
                    playerEmbed(player)
                ],

                components: [
                    playerRecordButtons(
                        playerId
                    )
                ]

            });

            return;
        }

        // ==================================
        // ADD CASE
        // ==================================

        if (
            interaction.isButton() &&
            interaction.customId.startsWith(
                'player_add_'
            )
        ) {

            const playerId =
                interaction.customId.replace(
                    'player_add_',
                    ''
                );

            if (!data.players[playerId]) {

                return interaction.reply({

                    content:
                        '❌ Player record not found.',

                    ephemeral: true

                });
            }

            await interaction.showModal(
                addCaseModal(playerId)
            );

            return;
        }

        // ==================================
        // EDIT CASE FROM PLAYER
        // ==================================

        if (
            interaction.isButton() &&
            interaction.customId.startsWith(
                'player_edit_'
            )
        ) {

            const playerId =
                interaction.customId.replace(
                    'player_edit_',
                    ''
                );

            const player =
                data.players[playerId];

            if (
                !player ||
                !player.cases ||
                player.cases.length === 0
            ) {

                return interaction.reply({

                    content:
                        '❌ No cases available to edit.',

                    ephemeral: true

                });
            }

            await interaction.update({

                content:
                    `✏️ **Select a Case to Edit**\n` +
                    `Player: **${player.ingameUsername}**`,

                embeds: [
                    playerEmbed(player)
                ],

                components: [

                    new ActionRowBuilder()
                        .addComponents(
                            caseSelectMenu(
                                playerId,
                                0
                            )
                        ),

                    new ActionRowBuilder()
                        .addComponents(

                            new ButtonBuilder()
                                .setCustomId(
                                    `player_add_${playerId}`
                                )
                                .setLabel(
                                    'Add Case'
                                )
                                .setEmoji('➕')
                                .setStyle(
                                    ButtonStyle.Success
                                ),

                            new ButtonBuilder()
                                .setCustomId(
                                    'player_close'
                                )
                                .setLabel(
                                    'Close'
                                )
                                .setEmoji('✖️')
                                .setStyle(
                                    ButtonStyle.Danger
                                )
                        )

                ]

            });

            return;
        }

        // ==================================
        // SELECT CASE
        // ==================================

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId.startsWith(
                'select_case_'
            )
        ) {

            const parts =
                interaction.customId.split('_');

            const playerId =
                parts[2];

            const caseNumber =
                interaction.values[0];

            const player =
                data.players[playerId];

            if (!player) {

                return interaction.update({

                    content:
                        '❌ Player not found.',

                    components: []

                });
            }

            const selectedCase =
                player.cases.find(
                    item =>
                        item.caseNumber ===
                        caseNumber
                );

            if (!selectedCase) {

                return interaction.update({

                    content:
                        '❌ Case not found.',

                    components: []

                });
            }

            if (!canEditCase(interaction, selectedCase)) {
                return interaction.reply({
                    content: '🔒 You can only edit cases you created. Discord Administrators can edit all cases.',
                    ephemeral: true
                });
            }

            await interaction.showModal(
                editCaseModal(
                    playerId,
                    caseNumber
                )
            );

            return;
        }

        // ==================================
        // ADD CASE MODAL SUBMIT
        // ==================================

        if (
            interaction.isModalSubmit() &&
            interaction.customId.startsWith(
                'add_case_'
            )
        ) {

            const playerId =
                interaction.customId.replace(
                    'add_case_',
                    ''
                );

            const player =
                data.players[playerId];

            if (!player) {

                return interaction.reply({

                    content:
                        '❌ Player record not found.',

                    ephemeral: true

                });
            }

            const game =
                interaction.fields.getTextInputValue(
                    'game'
                )
                .trim();

            const type =
                interaction.fields.getTextInputValue(
                    'type'
                )
                .trim();

            const action =
                interaction.fields.getTextInputValue(
                    'action'
                )
                .trim();

            const reason =
                interaction.fields.getTextInputValue(
                    'reason'
                )
                .trim();

            const notes =
                interaction.fields.getTextInputValue(
                    'notes'
                )
                .trim();

            const caseNumber =
                generateCaseNumber();

            player.cases.push({

                caseNumber,

                type,

                game,

                action,

                reason,

                notes,

                createdBy:
                    interaction.user.username,

                createdById:
                    interaction.user.id,

                createdAt:
                    new Date().toLocaleString(
                        'en-GB'
                    ),

                date:
                    new Date().toLocaleString(
                        'en-GB'
                    )

            });

            saveData();

            await interaction.reply({

                content:
                    `✅ **${caseNumber}** has been added to **${player.ingameUsername}**.`,

                embeds: [
                    playerEmbed(player)
                ],

                components: [
                    playerRecordButtons(
                        playerId
                    )
                ],

                ephemeral: true

            });

            return;
        }

        // ==================================
        // EDIT CASE MODAL SUBMIT
        // ==================================

        if (
            interaction.isModalSubmit() &&
            interaction.customId.startsWith(
                'edit_case_'
            )
        ) {

            const parts =
                interaction.customId.split('_');

            const playerId =
                parts[2];

            const caseNumber =
                `${parts[3]}-${parts[4]}`;

            const player =
                data.players[playerId];

            if (!player) {

                return interaction.reply({

                    content:
                        '❌ Player record not found.',

                    ephemeral: true

                });
            }

            const selectedCase =
                player.cases.find(
                    item =>
                        item.caseNumber ===
                        caseNumber
                );

            if (!selectedCase) {

                return interaction.reply({

                    content:
                        '❌ Case not found.',

                    ephemeral: true

                });
            }

            if (!canEditCase(interaction, selectedCase)) {
                return interaction.reply({
                    content: '🔒 You can only edit cases you created. Discord Administrators can edit all cases.',
                    ephemeral: true
                });
            }

            selectedCase.game =
                interaction.fields.getTextInputValue(
                    'game'
                )
                .trim();

            selectedCase.type =
                interaction.fields.getTextInputValue(
                    'type'
                )
                .trim();

            selectedCase.action =
                interaction.fields.getTextInputValue(
                    'action'
                )
                .trim();

            selectedCase.reason =
                interaction.fields.getTextInputValue(
                    'reason'
                )
                .trim();

            selectedCase.notes =
                interaction.fields.getTextInputValue(
                    'notes'
                )
                .trim();

            selectedCase.lastEditedBy =
                interaction.user.username;

            selectedCase.lastEditedById =
                interaction.user.id;

            selectedCase.lastEditedAt =
                new Date().toLocaleString(
                    'en-GB'
                );

            saveData();

            await interaction.reply({

                content:
                    `✅ **${caseNumber}** has been updated.`,

                embeds: [
                    playerEmbed(player)
                ],

                components: [
                    playerRecordButtons(
                        playerId
                    )
                ],

                ephemeral: true

            });

            return;
        }

        // ==================================
        // CLOSE PRIVATE VIEWS
        // ==================================

        if (
            interaction.isButton() &&
            interaction.customId ===
            'player_close'
        ) {

            await interaction.update({

                content:
                    '✅ Closed.',

                embeds: [],

                components: []

            });

            return;
        }
    }
);


// ========================================
// STAK NEXT GEN v1.0 SYSTEMS
// ========================================

const STORAGE_ROOT = path.join(__dirname, 'stak-storage');
const BACKUPS_ROOT = path.join(STORAGE_ROOT, 'backups');
const MESSAGE_ROOT = path.join(STORAGE_ROOT, 'messages');

function ensureStorage() {
    for (const dir of [STORAGE_ROOT, BACKUPS_ROOT, MESSAGE_ROOT]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
ensureStorage();

function hasAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true;
}

function hasGiveawayAccess(interaction) {
    if (hasAdmin(interaction)) return true;
    const ids = data.config?.giveaway?.allowedRoleIds || [];
    return ids.some(id => interaction.member?.roles?.cache?.has(id));
}

function isProtectedBotMember(member) {
    const botRoleId = data.config?.roles?.botRoleId;
    return Boolean(botRoleId && member?.roles?.cache?.has(botRoleId));
}

function channelMention(id) {
    return id ? `<#${id}>` : 'Not configured';
}

function roleMention(id) {
    return id ? `<@&${id}>` : 'None';
}

function writeText(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
}

async function sendConfiguredLog(guild, type, payload) {
    try {
        const channelId = data.config?.logger?.[`${type}ChannelId`];
        if (!channelId) return;
        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return;
        await channel.send({ embeds: [payload] });
    } catch (error) {
        console.error(`Logger error (${type}):`, error.message);
    }
}

function cleanLogEmbed(title, description) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description.slice(0, 4096))
        .setTimestamp();
}

function archiveMessage(message, action = 'created') {
    if (!message.guild || message.author?.bot) return;
    const guildDir = path.join(MESSAGE_ROOT, message.guild.id);
    const channelFile = path.join(guildDir, `${message.channel.id}.jsonl`);
    const record = {
        action,
        id: message.id,
        guildId: message.guild.id,
        channelId: message.channel.id,
        channelName: message.channel.name || null,
        authorId: message.author?.id || null,
        authorTag: message.author?.tag || message.author?.username || null,
        content: message.content || '',
        createdAt: message.createdTimestamp || Date.now(),
        editedAt: null,
        attachments: Array.from(message.attachments?.values?.() || []).map(a => ({
            id: a.id,
            name: a.name,
            size: a.size,
            url: a.url,
            contentType: a.contentType || null
        }))
    };
    try {
        fs.mkdirSync(guildDir, { recursive: true });
        fs.appendFileSync(channelFile, JSON.stringify(record) + '\n', 'utf8');
    } catch (error) {
        console.error('Message archive error:', error.message);
    }
}

function archiveEditedMessage(oldMessage, newMessage) {
    if (!newMessage?.guild || newMessage.author?.bot) return;
    const guildDir = path.join(MESSAGE_ROOT, newMessage.guild.id);
    const channelFile = path.join(guildDir, `${newMessage.channel.id}.jsonl`);
    const record = {
        action: 'edited',
        id: newMessage.id,
        guildId: newMessage.guild.id,
        channelId: newMessage.channel.id,
        channelName: newMessage.channel.name || null,
        authorId: newMessage.author?.id || oldMessage.author?.id || null,
        authorTag: newMessage.author?.tag || newMessage.author?.tag || null,
        before: oldMessage.content || '',
        content: newMessage.content || '',
        createdAt: newMessage.createdTimestamp || Date.now(),
        editedAt: Date.now(),
        attachments: Array.from(newMessage.attachments?.values?.() || []).map(a => ({ id: a.id, name: a.name, size: a.size, url: a.url, contentType: a.contentType || null }))
    };
    try {
        fs.mkdirSync(guildDir, { recursive: true });
        fs.appendFileSync(channelFile, JSON.stringify(record) + '\n', 'utf8');
    } catch (error) {
        console.error('Message edit archive error:', error.message);
    }
}

function getBackupDirectory(guildId, backupId) {
    return path.join(BACKUPS_ROOT, guildId, backupId);
}

async function createGuildSnapshot(guild) {
    ensureStorage();
    const backupId = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const dir = getBackupDirectory(guild.id, backupId);
    fs.mkdirSync(dir, { recursive: true });

    const roles = guild.roles.cache.map(role => ({
        id: role.id,
        name: role.name,
        color: role.hexColor,
        hoist: role.hoist,
        position: role.position,
        permissions: role.permissions.bitfield.toString(),
        mentionable: role.mentionable,
        managed: role.managed
    }));

    const channels = guild.channels.cache.map(channel => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId,
        position: channel.rawPosition ?? channel.position ?? 0,
        topic: 'topic' in channel ? channel.topic : null,
        nsfw: 'nsfw' in channel ? channel.nsfw : false,
        rateLimitPerUser: 'rateLimitPerUser' in channel ? channel.rateLimitPerUser : 0,
        bitrate: 'bitrate' in channel ? channel.bitrate : null,
        userLimit: 'userLimit' in channel ? channel.userLimit : null,
        rtcRegion: 'rtcRegion' in channel ? channel.rtcRegion : null,
        permissionOverwrites: channel.permissionOverwrites ? channel.permissionOverwrites.cache.map(overwrite => ({
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow.bitfield.toString(),
            deny: overwrite.deny.bitfield.toString()
        })) : []
    }));

    let bans = [];
    try {
        const fetchedBans = await guild.bans.fetch();
        bans = fetchedBans.map(ban => ({
            id: ban.user.id,
            username: ban.user.username,
            reason: ban.reason || null
        }));
    } catch (error) {
        console.error('Backup bans fetch failed:', error.message);
    }

    const emojis = guild.emojis.cache.map(emoji => ({
        id: emoji.id,
        name: emoji.name,
        url: emoji.url,
        animated: emoji.animated,
        roles: emoji.roles?.cache?.map(r => r.id) || []
    }));

    const stickers = guild.stickers.cache.map(sticker => ({
        id: sticker.id,
        name: sticker.name,
        description: sticker.description,
        format: sticker.format,
        url: sticker.url,
        tags: sticker.tags || null
    }));

    let memberRoles = [];
    try {
        await guild.members.fetch();
        memberRoles = guild.members.cache.map(member => ({
            id: member.id,
            roleIds: member.roles.cache.filter(role => role.id !== guild.id && !role.managed).map(role => role.id)
        }));
    } catch (error) {
        console.error('Backup member-role fetch failed:', error.message);
    }

    const snapshot = {
        version: '1.0',
        backupId,
        createdAt: new Date().toISOString(),
        guild: {
            id: guild.id,
            name: guild.name,
            description: guild.description,
            iconURL: guild.iconURL({ extension: 'png', size: 1024 }),
            bannerURL: guild.bannerURL({ extension: 'png', size: 1024 }),
            verificationLevel: guild.verificationLevel,
            defaultMessageNotifications: guild.defaultMessageNotifications,
            explicitContentFilter: guild.explicitContentFilter,
            afkChannelId: guild.afkChannelId,
            afkTimeout: guild.afkTimeout,
            systemChannelId: guild.systemChannelId,
            systemChannelFlags: guild.systemChannelFlags?.bitfield?.toString?.() || '0',
            preferredLocale: guild.preferredLocale,
            premiumProgressBarEnabled: guild.premiumProgressBarEnabled
        },
        roles,
        memberRoles,
        channels,
        bans,
        emojis,
        stickers,
        messageArchive: fs.existsSync(path.join(MESSAGE_ROOT, guild.id)) ? `messages/${guild.id}` : null
    };

    writeText(path.join(dir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));

    const messageSource = path.join(MESSAGE_ROOT, guild.id);
    const messageTarget = path.join(dir, 'messages');
    if (fs.existsSync(messageSource)) {
        fs.cpSync(messageSource, messageTarget, { recursive: true });
    }

    return { backupId, snapshot };
}

function listBackups(guildId) {
    const dir = path.join(BACKUPS_ROOT, guildId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => fs.existsSync(path.join(dir, name, 'snapshot.json'))).sort().reverse();
}

async function restoreGuildSnapshot(guild, backupId) {
    const dir = getBackupDirectory(guild.id, backupId);
    const file = path.join(dir, 'snapshot.json');
    if (!fs.existsSync(file)) throw new Error('Backup snapshot not found.');
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    const roleMap = new Map();
    const channelMap = new Map();

    // Restore server-level basics where Discord permits it.
    try {
        await guild.setName(snapshot.guild.name);
    } catch (_) {}
    try {
        if (snapshot.guild.description !== undefined) await guild.setDescription(snapshot.guild.description || '');
    } catch (_) {}
    try {
        if (snapshot.guild.iconURL) await guild.setIcon(snapshot.guild.iconURL);
    } catch (_) {}
    try {
        if (snapshot.guild.bannerURL && guild.setBanner) await guild.setBanner(snapshot.guild.bannerURL);
    } catch (_) {}

    // Restore roles, lowest first; managed roles are ignored.
    const roles = [...snapshot.roles].filter(r => !r.managed && r.id !== guild.id).sort((a, b) => a.position - b.position);
    for (const oldRole of roles) {
        let role = guild.roles.cache.find(r => r.name === oldRole.name && !r.managed);
        try {
            if (!role) {
                role = await guild.roles.create({
                    name: oldRole.name,
                    color: oldRole.color,
                    hoist: oldRole.hoist,
                    permissions: BigInt(oldRole.permissions),
                    mentionable: oldRole.mentionable,
                    reason: `STAK Backup Restore ${backupId}`
                });
            }
            roleMap.set(oldRole.id, role.id);
        } catch (error) {
            console.error(`Role restore failed (${oldRole.name}):`, error.message);
        }
    }

    // Restore categories first.
    const sortedChannels = [...snapshot.channels].sort((a, b) => a.position - b.position);
    for (const oldChannel of sortedChannels.filter(c => c.type === ChannelType.GuildCategory)) {
        let ch = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === oldChannel.name);
        try {
            if (!ch) {
                ch = await guild.channels.create({ name: oldChannel.name, type: ChannelType.GuildCategory, reason: `STAK Backup Restore ${backupId}` });
            }
            channelMap.set(oldChannel.id, ch.id);
        } catch (error) {
            console.error(`Category restore failed (${oldChannel.name}):`, error.message);
        }
    }

    // Restore regular channels.
    for (const oldChannel of sortedChannels.filter(c => c.type !== ChannelType.GuildCategory)) {
        let ch = guild.channels.cache.find(c => c.name === oldChannel.name && c.type === oldChannel.type);
        try {
            const parentId = oldChannel.parentId ? channelMap.get(oldChannel.parentId) || null : null;
            if (!ch) {
                const options = { name: oldChannel.name, type: oldChannel.type, reason: `STAK Backup Restore ${backupId}` };
                if (parentId) options.parent = parentId;
                if (oldChannel.topic !== null && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(oldChannel.type)) options.topic = oldChannel.topic;
                if ([ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(oldChannel.type)) {
                    options.nsfw = Boolean(oldChannel.nsfw);
                    options.rateLimitPerUser = oldChannel.rateLimitPerUser || 0;
                }
                if (oldChannel.bitrate && oldChannel.type === ChannelType.GuildVoice) options.bitrate = oldChannel.bitrate;
                if (oldChannel.userLimit && oldChannel.type === ChannelType.GuildVoice) options.userLimit = oldChannel.userLimit;
                ch = await guild.channels.create(options);
            }
            channelMap.set(oldChannel.id, ch.id);
        } catch (error) {
            console.error(`Channel restore failed (${oldChannel.name}):`, error.message);
        }
    }

    // Restore basic channel permissions using mapped role IDs.
    for (const oldChannel of snapshot.channels) {
        const chId = channelMap.get(oldChannel.id);
        if (!chId) continue;
        const ch = guild.channels.cache.get(chId);
        if (!ch || !oldChannel.permissionOverwrites?.length) continue;
        const overwrites = [];
        for (const ow of oldChannel.permissionOverwrites) {
            const targetId = ow.id === guild.id ? guild.id : (roleMap.get(ow.id) || ow.id);
            overwrites.push({ id: targetId, allow: BigInt(ow.allow), deny: BigInt(ow.deny), type: ow.type });
        }
        try { await ch.permissionOverwrites.set(overwrites, `STAK Backup Restore ${backupId}`); } catch (error) { console.error(`Permission restore failed (${oldChannel.name}):`, error.message); }
    }

    // Restore bans.
    for (const ban of snapshot.bans || []) {
        try {
            await guild.members.ban(ban.id, { reason: `STAK Backup Restore ${backupId}` });
        } catch (_) {}
    }

    // Restore role assignments for members that are still in the server.
    try {
        await guild.members.fetch();
        for (const memberRecord of snapshot.memberRoles || []) {
            const member = guild.members.cache.get(memberRecord.id);
            if (!member) continue;
            const mappedRoles = (memberRecord.roleIds || []).map(id => roleMap.get(id)).filter(Boolean);
            if (mappedRoles.length) await member.roles.set(mappedRoles, `STAK Backup Restore ${backupId}`).catch(() => null);
        }
    } catch (error) {
        console.error('Member role restore failed:', error.message);
    }

    // Restore emojis where the CDN URL is still usable.
    for (const emoji of snapshot.emojis || []) {
        if (guild.emojis.cache.some(e => e.name === emoji.name)) continue;
        try {
            await guild.emojis.create({ attachment: emoji.url, name: emoji.name, reason: `STAK Backup Restore ${backupId}` });
        } catch (error) {
            console.error(`Emoji restore failed (${emoji.name}):`, error.message);
        }
    }

    return { roleMap, channelMap, note: 'Messages are preserved in the snapshot/archive. Discord does not allow the bot to recreate messages as their original authors; message restoration is therefore archival rather than impersonation.' };
}

function buildManagementEmbed() {
    const c = data.config;
    return new EmbedBuilder()
        .setTitle('STAK Management')
        .setDescription('Central configuration for the STAK Management bot.')
        .addFields(
            { name: 'Logger', value: `Mod: ${channelMention(c.logger.modChannelId)}\nAudit: ${channelMention(c.logger.auditChannelId)}\nCommunity: ${channelMention(c.logger.communityChannelId)}` },
            { name: 'Honeypot', value: c.honeypot.enabled ? channelMention(c.honeypot.channelId) : 'Disabled' },
            { name: 'Community Member Role', value: roleMention(c.roles.communityRoleId) },
            { name: 'Protected Bot Role', value: roleMention(c.roles.botRoleId) },
            { name: 'Booster Messages', value: c.booster.enabled ? channelMention(c.booster.channelId) : 'Disabled' },
            { name: 'Giveaway Access', value: c.giveaway.allowedRoleIds.length ? c.giveaway.allowedRoleIds.map(roleMention).join(', ') : 'Administrators only' },
            { name: 'YouTube Channels', value: String(Object.keys(c.youtube.channels || {}).length) }
        )
        .setTimestamp();
}

function managementButtons() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ng_cfg_logger').setLabel('Logger').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ng_cfg_honeypot').setLabel('Honeypot').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ng_cfg_roles').setLabel('Roles').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ng_cfg_booster').setLabel('Booster').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ng_cfg_youtube').setLabel('YouTube').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ng_cfg_giveaway').setLabel('Giveaway Access').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ng_cfg_backup').setLabel('Backups').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('ng_cfg_refresh').setLabel('Refresh').setStyle(ButtonStyle.Success)
        )
    ];
}

function loggerChannelMenus() {
    return [
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('ng_select_log_mod').setPlaceholder('Select Mod Logs channel').setChannelTypes(ChannelType.GuildText)),
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('ng_select_log_audit').setPlaceholder('Select Audit Logs channel').setChannelTypes(ChannelType.GuildText)),
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('ng_select_log_community').setPlaceholder('Select Community Logs channel').setChannelTypes(ChannelType.GuildText))
    ];
}

function roleConfigMenu() {
    return new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('ng_select_community_role').setPlaceholder('Select Community Member role').setMinValues(1).setMaxValues(1));
}

function botRoleConfigMenu() {
    return new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('ng_select_bot_role').setPlaceholder('Select protected Bot role').setMinValues(1).setMaxValues(1));
}

function youtubeTemplateModal() {
    return new ModalBuilder()
        .setCustomId('ng_modal_yt_template')
        .setTitle('YouTube Message Template')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('template').setLabel('Message').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(data.config.youtube.template.slice(0, 4000))
            )
        );
}

function giveawayModal() {
    return new ModalBuilder()
        .setCustomId('ng_modal_giveaway')
        .setTitle('Create Giveaway')
        .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('prize').setLabel('Prize').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('winners').setLabel('Number of Winners').setStyle(TextInputStyle.Short).setRequired(true).setValue('1')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel('Duration (e.g. 2h, 7d)').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('requirements').setLabel('Requirements').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000))
        );
}

function parseDuration(input) {
    const match = String(input || '').trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
    return amount * mult;
}

function giveawayEmbed(giveaway) {
    const remaining = Math.max(0, giveaway.endsAt - Date.now());
    const ended = remaining === 0;
    return new EmbedBuilder()
        .setTitle('STAK Giveaway')
        .setDescription(`**Prize**\n${giveaway.prize}\n\n**Description**\n${giveaway.description}\n\n**Requirements**\n${giveaway.requirements || 'None'}\n\n**Winners**\n${giveaway.winners}\n\n**Ends**\n<t:${Math.floor(giveaway.endsAt / 1000)}:R>${ended ? '\n\n**Ended**' : ''}`)
        .setFooter({ text: ended ? 'Giveaway ended' : `Entries: ${giveaway.entries.length}` })
        .setTimestamp();
}

function giveawayButton(id, ended = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ng_giveaway_join|${id}`).setLabel(ended ? 'Giveaway Ended' : 'Enter Giveaway').setStyle(ended ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(ended)
    );
}

async function finishGiveaway(guildId, giveawayId) {
    const giveaway = data.giveaways[giveawayId];
    if (!giveaway || giveaway.ended) return;
    giveaway.ended = true;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) { saveData(); return; }
    const channel = guild.channels.cache.get(giveaway.channelId);
    if (!channel) { saveData(); return; }
    let winners = [];
    const pool = [...new Set(giveaway.entries)];
    for (let i = 0; i < Math.min(giveaway.winners, pool.length); i++) {
        const index = Math.floor(Math.random() * pool.length);
        winners.push(pool.splice(index, 1)[0]);
    }
    giveaway.winnerIds = winners;
    saveData();
    try {
        const msg = await channel.messages.fetch(giveaway.messageId);
        await msg.edit({ embeds: [giveawayEmbed(giveaway)], components: [giveawayButton(giveawayId, true)] });
        await channel.send(`Giveaway ended. ${winners.length ? winners.map(id => `<@${id}>`).join(', ') : 'No valid winners'} won **${giveaway.prize}**.`);
    } catch (error) {
        console.error('Giveaway finish error:', error.message);
    }
}

function renderYouTubeTemplate(template, item) {
    return String(template || '')
        .replaceAll('{channel}', item.channelName)
        .replaceAll('{title}', item.title)
        .replaceAll('{url}', item.url)
        .replaceAll('{mention}', item.mention || '');
}

async function pollYouTube() {
    const channels = data.config?.youtube?.channels || {};
    for (const [channelId, cfg] of Object.entries(channels)) {
        try {
            const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
            if (!response.ok) continue;
            const xml = await response.text();
            const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
            if (!entryMatch) continue;
            const entry = entryMatch[1];
            const videoId = (entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
            const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
            const channelName = (entry.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || cfg.channelName || channelId;
            const published = (entry.match(/<published>([^<]+)<\/published>/) || [])[1];
            if (!videoId || !title) continue;
            const last = cfg.lastVideoId;
            if (last === videoId) continue;
            // Initialize silently; only send when a newer upload is observed after configuration.
            if (!last) {
                cfg.lastVideoId = videoId;
                cfg.channelName = channelName;
                saveData();
                continue;
            }
            cfg.lastVideoId = videoId;
            cfg.channelName = channelName;
            saveData();
            const channel = client.channels.cache.get(cfg.targetChannelId) || await client.channels.fetch(cfg.targetChannelId).catch(() => null);
            if (!channel || !channel.isTextBased()) continue;
            const roleId = cfg.pingRoleId || data.config.youtube.defaultPingRoleId;
            const mention = roleId ? `<@&${roleId}>` : '';
            const url = `https://www.youtube.com/watch?v=${videoId}`;
            const content = renderYouTubeTemplate(data.config.youtube.template, { channelName, title, url, mention });
            const embed = new EmbedBuilder()
                .setThumbnail(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`)
                .setTimestamp(published ? new Date(published) : new Date());
            await channel.send({ content, embeds: [embed], allowedMentions: { roles: roleId ? [roleId] : [] } });
        } catch (error) {
            console.error(`YouTube poll error (${channelId}):`, error.message);
        }
    }
}

// Message archive + honeypot
client.on('messageCreate', async message => {
    if (!message.guild) return;

    if (message.author?.bot) {
        return;
    }

    if (data.config?.honeypot?.enabled && message.channel.id === data.config.honeypot.channelId) {
        if (isProtectedBotMember(message.member)) return;
        try { await message.delete().catch(() => null); } catch (_) {}
        try {
            await message.guild.members.ban(message.author.id, { deleteMessageSeconds: 604800, reason: 'STAK Honeypot trigger' });
            await message.guild.members.unban(message.author.id, 'STAK Honeypot softban');
            await sendConfiguredLog(message.guild, 'mod', cleanLogEmbed('Honeypot Softban', `**User:** <@${message.author.id}> (${message.author.id})\n**Channel:** ${message.channel}\n**Action:** Softban`));
        } catch (error) {
            console.error('Honeypot action failed:', error.message);
        }
        return;
    }

    archiveMessage(message);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
        if (newMessage.partial) await newMessage.fetch().catch(() => null);
        if (!newMessage.guild || newMessage.author?.bot) return;
        archiveEditedMessage(oldMessage, newMessage);
    } catch (_) {}
});

client.on('messageDelete', async message => {
    if (!message.guild || message.author?.bot) return;
    archiveMessage(message, 'deleted');
    await sendConfiguredLog(message.guild, 'mod', cleanLogEmbed('Message Deleted', `**Channel:** ${message.channel}\n**Author:** ${message.author ? `<@${message.author.id}>` : 'Unknown'}\n**Message ID:** ${message.id}\n**Content:** ${message.content || '[not cached]'}`));
});

client.on('messageDeleteBulk', async messages => {
    const first = messages.first();
    if (!first?.guild) return;
    await sendConfiguredLog(first.guild, 'mod', cleanLogEmbed('Bulk Message Delete', `**Channel:** ${first.channel}\n**Messages:** ${messages.size}`));
});

// Community events
client.on('guildMemberAdd', async member => {
    if (data.config?.roles?.communityRoleId) {
        const role = member.guild.roles.cache.get(data.config.roles.communityRoleId);
        if (role && !member.roles.cache.has(role.id)) await member.roles.add(role, 'STAK automatic Community Member role').catch(() => null);
    }
    await sendConfiguredLog(member.guild, 'community', cleanLogEmbed('Member Joined', `**User:** <@${member.id}> (${member.user.tag})`));
});

client.on('guildMemberRemove', async member => {
    await sendConfiguredLog(member.guild, 'community', cleanLogEmbed('Member Left', `**User:** ${member.user?.tag || member.id} (${member.id})`));
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (!oldState.channelId && newState.channelId) {
        await sendConfiguredLog(newState.guild, 'community', cleanLogEmbed('Voice Joined', `**User:** <@${newState.id}>\n**Channel:** <#${newState.channelId}>`));
    } else if (oldState.channelId && !newState.channelId) {
        await sendConfiguredLog(newState.guild, 'community', cleanLogEmbed('Voice Left', `**User:** <@${newState.id}>\n**Channel:** <#${oldState.channelId}>`));
    } else if (oldState.channelId !== newState.channelId) {
        await sendConfiguredLog(newState.guild, 'community', cleanLogEmbed('Voice Moved', `**User:** <@${newState.id}>\n**From:** <#${oldState.channelId}>\n**To:** <#${newState.channelId}>`));
    }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const oldBoost = oldMember.premiumSince;
    const newBoost = newMember.premiumSince;
    if (!oldBoost && newBoost && data.config?.booster?.enabled && data.config.booster.channelId) {
        const channel = newMember.guild.channels.cache.get(data.config.booster.channelId);
        if (channel?.isTextBased()) {
            const messages = [
                `<@${newMember.id}> has just boosted the server, thank you so much for the support. We really appreciate it!`,
                `<@${newMember.id}> just boosted our server. Thank you for your amazing support, we truly appreciate it.`,
                `<@${newMember.id}> has just boosted the server. We are really thankful for all the support. Thank you so much!`
            ];
            await channel.send(messages[Math.floor(Math.random() * messages.length)]).catch(() => null);
        }
    }
    if (oldMember.nickname !== newMember.nickname && newMember.guild) {
        await sendConfiguredLog(newMember.guild, 'community', cleanLogEmbed('Nickname Updated', `**User:** <@${newMember.id}>\n**Before:** ${oldMember.nickname || oldMember.user.username}\n**After:** ${newMember.nickname || newMember.user.username}`));
    }
});

// Discord administrative events / Audit Logs
client.on('guildAuditLogEntryCreate', async (entry, guild) => {
    const executor = entry.executor ? `<@${entry.executor.id}>` : 'Unknown';
    const target = entry.targetId ? `${entry.targetType || 'Target'} (${entry.targetId})` : 'Unknown';
    const changes = entry.changes?.map(change => `• ${change.key}: ${JSON.stringify(change.old)} → ${JSON.stringify(change.new)}`).join('\n') || 'No detailed change data.';
    const description = `**Action:** \`${String(entry.action)}\`\n**Executor:** ${executor}\n**Target:** ${target}\n**Reason:** ${entry.reason || 'No reason provided.'}\n\n${changes}`;
    await sendConfiguredLog(guild, 'audit', cleanLogEmbed('Audit Log Entry', description));

    const modActions = [
        AuditLogEvent.MemberBanAdd,
        AuditLogEvent.MemberBanRemove,
        AuditLogEvent.MemberKick,
        AuditLogEvent.MemberUpdate,
        AuditLogEvent.MessageDelete,
        AuditLogEvent.MessageBulkDelete,
        AuditLogEvent.MessagePin,
        AuditLogEvent.MessageUnpin
    ];
    if (modActions.includes(entry.action)) {
        await sendConfiguredLog(guild, 'mod', cleanLogEmbed('Moderation Log', description));
    }
});

// Create/update/delete events that are not always convenient to reconstruct later.
client.on('channelCreate', async channel => { if (channel.guild) await sendConfiguredLog(channel.guild, 'audit', cleanLogEmbed('Channel Created', `**Channel:** ${channel}\n**Name:** ${channel.name}\n**Type:** ${channel.type}`)); });
client.on('channelDelete', async channel => { if (channel.guild) await sendConfiguredLog(channel.guild, 'audit', cleanLogEmbed('Channel Deleted', `**Name:** ${channel.name}\n**ID:** ${channel.id}`)); });
client.on('channelUpdate', async (oldChannel, newChannel) => { if (newChannel.guild) await sendConfiguredLog(newChannel.guild, 'audit', cleanLogEmbed('Channel Updated', `**Channel:** <#${newChannel.id}>\n**Name:** ${oldChannel.name} → ${newChannel.name}`)); });
client.on('roleCreate', async role => { await sendConfiguredLog(role.guild, 'audit', cleanLogEmbed('Role Created', `**Role:** ${role} (${role.name})`)); });
client.on('roleDelete', async role => { await sendConfiguredLog(role.guild, 'audit', cleanLogEmbed('Role Deleted', `**Name:** ${role.name}\n**ID:** ${role.id}`)); });
client.on('roleUpdate', async (oldRole, newRole) => { await sendConfiguredLog(newRole.guild, 'audit', cleanLogEmbed('Role Updated', `**Role:** ${newRole}\n**Before:** ${oldRole.name}\n**After:** ${newRole.name}`)); });
client.on('emojiCreate', async emoji => { await sendConfiguredLog(emoji.guild, 'audit', cleanLogEmbed('Emoji Created', `**Emoji:** ${emoji.name} (${emoji.id})`)); });
client.on('emojiDelete', async emoji => { await sendConfiguredLog(emoji.guild, 'audit', cleanLogEmbed('Emoji Deleted', `**Name:** ${emoji.name}\n**ID:** ${emoji.id}`)); });
client.on('emojiUpdate', async (oldEmoji, newEmoji) => { await sendConfiguredLog(newEmoji.guild, 'audit', cleanLogEmbed('Emoji Updated', `**Before:** ${oldEmoji.name}\n**After:** ${newEmoji.name}`)); });
client.on('stickerCreate', async sticker => { await sendConfiguredLog(sticker.guild, 'audit', cleanLogEmbed('Sticker Created', `**Sticker:** ${sticker.name} (${sticker.id})`)); });
client.on('stickerDelete', async sticker => { await sendConfiguredLog(sticker.guild, 'audit', cleanLogEmbed('Sticker Deleted', `**Name:** ${sticker.name}\n**ID:** ${sticker.id}`)); });
client.on('stickerUpdate', async (oldSticker, newSticker) => { await sendConfiguredLog(newSticker.guild, 'audit', cleanLogEmbed('Sticker Updated', `**Before:** ${oldSticker.name}\n**After:** ${newSticker.name}`)); });
client.on('inviteCreate', async invite => { if (invite.guild) await sendConfiguredLog(invite.guild, 'community', cleanLogEmbed('Invite Created', `**Code:** ${invite.code}\n**Channel:** ${invite.channel || 'Unknown'}\n**Creator:** ${invite.inviter ? `<@${invite.inviter.id}>` : 'Unknown'}`)); });
client.on('inviteDelete', async invite => { if (invite.guild) await sendConfiguredLog(invite.guild, 'community', cleanLogEmbed('Invite Deleted', `**Code:** ${invite.code}`)); });
client.on('threadCreate', async thread => { await sendConfiguredLog(thread.guild, 'community', cleanLogEmbed('Thread Created', `**Thread:** <#${thread.id}>\n**Parent:** <#${thread.parentId}>`)); });
client.on('threadDelete', async thread => { await sendConfiguredLog(thread.guild, 'community', cleanLogEmbed('Thread Deleted', `**Name:** ${thread.name}\n**ID:** ${thread.id}`)); });
client.on('threadUpdate', async (oldThread, newThread) => { await sendConfiguredLog(newThread.guild, 'community', cleanLogEmbed('Thread Updated', `**Before:** ${oldThread.name}\n**After:** ${newThread.name}`)); });
client.on('guildScheduledEventCreate', async event => { await sendConfiguredLog(event.guild, 'community', cleanLogEmbed('Scheduled Event Created', `**Event:** ${event.name} (${event.id})`)); });
client.on('guildScheduledEventDelete', async event => { await sendConfiguredLog(event.guild, 'community', cleanLogEmbed('Scheduled Event Deleted', `**Event:** ${event.name} (${event.id})`)); });
client.on('guildScheduledEventUpdate', async (oldEvent, newEvent) => { await sendConfiguredLog(newEvent.guild, 'community', cleanLogEmbed('Scheduled Event Updated', `**Before:** ${oldEvent.name}\n**After:** ${newEvent.name}`)); });

// ========================================
// NEXT GEN INTERACTIONS
// ========================================

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            const name = interaction.commandName;

            if (name === 'management') {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                return interaction.reply({ embeds: [buildManagementEmbed()], components: managementButtons(), ephemeral: true });
            }

            if (name === 'backup') {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                const sub = interaction.options.getSubcommand();
                if (sub === 'create') {
                    await interaction.deferReply({ ephemeral: true });
                    const result = await createGuildSnapshot(interaction.guild);
                    return interaction.editReply(`Backup created successfully.\nID: \`${result.backupId}\`\nSaved to the STAK backup store.`);
                }
                if (sub === 'list') {
                    const list = listBackups(interaction.guild.id);
                    return interaction.reply({ content: list.length ? list.slice(0, 25).map(id => `• \`${id}\``).join('\n') : 'No backups found.', ephemeral: true });
                }
                if (sub === 'restore') {
                    const id = interaction.options.getString('id', true);
                    return interaction.reply({ content: `Restore \`${id}\`? This changes server structure and cannot recreate messages as their original authors.`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ng_confirm_restore|${id}`).setLabel('Confirm Restore').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('ng_cancel_restore').setLabel('Cancel').setStyle(ButtonStyle.Secondary))], ephemeral: true });
                }
            }

            if (name === 'logger') {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                const sub = interaction.options.getSubcommand();
                if (sub === 'show') return interaction.reply({ embeds: [buildManagementEmbed()], ephemeral: true });
                const type = interaction.options.getString('type', true);
                const channel = interaction.options.getChannel('channel', true);
                data.config.logger[`${type}ChannelId`] = channel.id;
                saveData();
                return interaction.reply({ content: `${type} logs will now be sent to ${channel}.`, ephemeral: true });
            }

            if (name === 'honeypot') {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                const sub = interaction.options.getSubcommand();
                if (sub === 'disable') {
                    data.config.honeypot.enabled = false;
                    saveData();
                    return interaction.reply({ content: 'Honeypot disabled.', ephemeral: true });
                }
                const channel = interaction.options.getChannel('channel', true);
                data.config.honeypot.channelId = channel.id;
                data.config.honeypot.enabled = true;
                const embed = new EmbedBuilder()
                    .setTitle('Honeypot Channel')
                    .setDescription('Do not send messages in this channel.\n\nThis channel is monitored to identify spam and automated accounts. Any message sent here may trigger an automatic soft ban.')
                    .setTimestamp();
                const msg = await channel.send({ embeds: [embed] });
                data.config.honeypot.panelMessageId = msg.id;
                saveData();
                return interaction.reply({ content: `Honeypot enabled in ${channel}.`, ephemeral: true });
            }

            if (name === 'giveaway') {
                if (!hasGiveawayAccess(interaction)) return interaction.reply({ content: 'You do not have permission to create giveaways.', ephemeral: true });
                return interaction.showModal(giveawayModal());
            }

            if (name === 'giveaway-access') {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                const role = interaction.options.getRole('role', true);
                const ids = data.config.giveaway.allowedRoleIds;
                if (ids.includes(role.id)) {
                    data.config.giveaway.allowedRoleIds = ids.filter(id => id !== role.id);
                    saveData();
                    return interaction.reply({ content: `${role} removed from Giveaway Access.`, ephemeral: true });
                }
                ids.push(role.id);
                saveData();
                return interaction.reply({ content: `${role} added to Giveaway Access.`, ephemeral: true });
            }

            if (name === 'youtube') {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                const sub = interaction.options.getSubcommand();
                if (sub === 'add') {
                    const channelId = interaction.options.getString('channel_id', true).trim();
                    const target = interaction.options.getChannel('target', true);
                    const pingRole = interaction.options.getRole('ping_role');
                    data.config.youtube.channels[channelId] = { channelId, targetChannelId: target.id, pingRoleId: pingRole?.id || null, channelName: null, lastVideoId: null };
                    saveData();
                    return interaction.reply({ content: `YouTube channel \`${channelId}\` is now monitored and will post in ${target}.`, ephemeral: true });
                }
                if (sub === 'remove') {
                    const channelId = interaction.options.getString('channel_id', true).trim();
                    if (!data.config.youtube.channels[channelId]) return interaction.reply({ content: 'That YouTube channel is not configured.', ephemeral: true });
                    delete data.config.youtube.channels[channelId];
                    saveData();
                    return interaction.reply({ content: `YouTube channel \`${channelId}\` removed.`, ephemeral: true });
                }
                if (sub === 'list') {
                    const entries = Object.values(data.config.youtube.channels);
                    return interaction.reply({ content: entries.length ? entries.map(c => `• \`${c.channelId}\` → <#${c.targetChannelId}>`).join('\n') : 'No YouTube channels configured.', ephemeral: true });
                }
                if (sub === 'template') return interaction.showModal(youtubeTemplateModal());
            }

            if (name === 'booster') {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                const sub = interaction.options.getSubcommand();
                if (sub === 'disable') {
                    data.config.booster.enabled = false;
                    saveData();
                    return interaction.reply({ content: 'Booster messages disabled.', ephemeral: true });
                }
                const channel = interaction.options.getChannel('channel', true);
                data.config.booster.channelId = channel.id;
                data.config.booster.enabled = true;
                saveData();
                return interaction.reply({ content: `Booster messages will be sent to ${channel}.`, ephemeral: true });
            }

            if (name === 'roles') {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                const sub = interaction.options.getSubcommand();
                const role = interaction.options.getRole('role', true);
                if (sub === 'community') data.config.roles.communityRoleId = role.id;
                if (sub === 'bot') data.config.roles.botRoleId = role.id;
                saveData();
                return interaction.reply({ content: sub === 'community' ? `${role} is now the automatic Community Member role.` : `${role} is now the protected Bot role.`, ephemeral: true });
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'ng_modal_yt_template') {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                data.config.youtube.template = interaction.fields.getTextInputValue('template');
                saveData();
                return interaction.reply({ content: 'YouTube message template updated.', ephemeral: true });
            }

            if (interaction.customId === 'ng_modal_giveaway') {
                if (!hasGiveawayAccess(interaction)) return interaction.reply({ content: 'You do not have permission to create giveaways.', ephemeral: true });
                const prize = interaction.fields.getTextInputValue('prize').trim();
                const winners = Math.max(1, Math.min(50, Number(interaction.fields.getTextInputValue('winners')) || 1));
                const duration = parseDuration(interaction.fields.getTextInputValue('duration'));
                const description = interaction.fields.getTextInputValue('description').trim();
                const requirements = interaction.fields.getTextInputValue('requirements').trim();
                if (!duration || duration < 10000 || duration > 60 * 24 * 3600000) return interaction.reply({ content: 'Invalid duration. Use formats like `30m`, `2h`, `7d`, or `1w`.', ephemeral: true });
                const giveawayId = `${interaction.guild.id}-${Date.now()}`;
                const giveaway = { id: giveawayId, guildId: interaction.guild.id, channelId: interaction.channel.id, createdById: interaction.user.id, prize, winners, duration, endsAt: Date.now() + duration, description, requirements, entries: [], ended: false, messageId: null, winnerIds: [] };
                const msg = await interaction.channel.send({ embeds: [giveawayEmbed(giveaway)], components: [giveawayButton(giveawayId)] });
                giveaway.messageId = msg.id;
                data.giveaways[giveawayId] = giveaway;
                saveData();
                setTimeout(() => finishGiveaway(interaction.guild.id, giveawayId), duration);
                return interaction.reply({ content: `Giveaway created in ${interaction.channel}.`, ephemeral: true });
            }
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'ng_cfg_refresh') return interaction.update({ embeds: [buildManagementEmbed()], components: managementButtons() });
            if (interaction.customId === 'ng_cfg_logger') {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                return interaction.reply({ content: 'Select a channel for Mod Logs:', components: loggerChannelMenus(), ephemeral: true });
            }
            if (interaction.customId === 'ng_cfg_roles') {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                return interaction.reply({ content: 'Select the Community Member role:', components: [roleConfigMenu(), botRoleConfigMenu()], ephemeral: true });
            }
            if (interaction.customId === 'ng_cfg_honeypot') return interaction.reply({ content: 'Use `/honeypot setup` or `/honeypot disable` to configure the Honeypot.', ephemeral: true });
            if (interaction.customId === 'ng_cfg_booster') return interaction.reply({ content: 'Use `/booster set-channel` or `/booster disable` to configure Booster Messages.', ephemeral: true });
            if (interaction.customId === 'ng_cfg_youtube') return interaction.reply({ content: 'Use `/youtube add`, `/youtube remove`, `/youtube list`, or `/youtube template` to configure YouTube notifications.', ephemeral: true });
            if (interaction.customId === 'ng_cfg_giveaway') return interaction.reply({ content: 'Use `/giveaway-access @Role` to allow a role to create giveaways.', ephemeral: true });
            if (interaction.customId === 'ng_cfg_backup') return interaction.reply({ content: 'Use `/backup create`, `/backup list`, and `/backup restore <id>`. Administrator permission is required.', ephemeral: true });
            if (interaction.customId === 'ng_cancel_restore') return interaction.update({ content: 'Restore cancelled.', components: [] });
            if (interaction.customId.startsWith('ng_confirm_restore|')) {
                if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                const backupId = interaction.customId.split('|')[1];
                await interaction.update({ content: `Restoring \`${backupId}\`...`, components: [] });
                try {
                    const result = await restoreGuildSnapshot(interaction.guild, backupId);
                    await interaction.editReply({ content: `Restore completed for \`${backupId}\`.\n\n${result.note}` });
                } catch (error) {
                    await interaction.editReply({ content: `Restore failed: ${error.message}` });
                }
                return;
            }
            if (interaction.customId.startsWith('ng_giveaway_join|')) {
                const id = interaction.customId.split('|')[1];
                const giveaway = data.giveaways[id];
                if (!giveaway || giveaway.ended || Date.now() >= giveaway.endsAt) return interaction.reply({ content: 'This giveaway has ended.', ephemeral: true });
                if (giveaway.entries.includes(interaction.user.id)) return interaction.reply({ content: 'You are already entered.', ephemeral: true });
                giveaway.entries.push(interaction.user.id);
                saveData();
                return interaction.reply({ content: 'You have been entered into the giveaway.', ephemeral: true });
            }
        }

        if (interaction.isChannelSelectMenu()) {
            if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
            const channelId = interaction.values[0];
            if (interaction.customId === 'ng_select_log_mod') data.config.logger.modChannelId = channelId;
            if (interaction.customId === 'ng_select_log_audit') data.config.logger.auditChannelId = channelId;
            if (interaction.customId === 'ng_select_log_community') data.config.logger.communityChannelId = channelId;
            saveData();
            return interaction.reply({ content: 'Logging channel updated.', ephemeral: true });
        }

        if (interaction.isRoleSelectMenu()) {
            if (!hasAdmin(interaction)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
            const roleId = interaction.values[0];
            if (interaction.customId === 'ng_select_community_role') data.config.roles.communityRoleId = roleId;
            if (interaction.customId === 'ng_select_bot_role') data.config.roles.botRoleId = roleId;
            saveData();
            return interaction.reply({ content: 'Role configuration updated.', ephemeral: true });
        }
    } catch (error) {
        console.error('Next Gen interaction error:', error);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'An internal error occurred. Check the bot console.', ephemeral: true }).catch(() => null);
        }
    }
});

// ========================================
// NEXT GEN STARTUP TASKS
// ========================================

client.once('clientReady', () => {
    // Resume pending giveaways after restart.
    for (const giveaway of Object.values(data.giveaways || {})) {
        if (!giveaway.ended) {
            const delay = Math.max(0, giveaway.endsAt - Date.now());
            setTimeout(() => finishGiveaway(giveaway.guildId, giveaway.id), Math.min(delay, 2147483647));
        }
    }
    // Poll YouTube feeds periodically. The feed is public and does not require a YouTube API key.
    pollYouTube().catch(() => null);
    setInterval(pollYouTube, 120000);
});

// ========================================
// TOKEN
// ========================================

if (!TOKEN) {

    console.error(
        '❌ DISCORD_TOKEN is missing from .env'
    );

    process.exit(1);
}

// ========================================
// LOGIN
// ========================================

client.login(TOKEN);