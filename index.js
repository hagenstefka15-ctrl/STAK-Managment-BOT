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
    PermissionFlagsBits
} = require('discord.js');

const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIG
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

const DATA_FILE = path.join(__dirname, 'stak-data.json');

const PLAYERS_PER_PAGE = 25;
const CASES_PER_PAGE = 25;

// ============================================================
// DATABASE
// ============================================================

let data = {
    staff: {},
    players: {},
    nextCaseNumber: 1,

    activityPanelChannelId: null,
    activityPanelMessageId: null,

    casePanelChannelId: null,
    casePanelMessageId: null
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
            nextCaseNumber:
                Number(saved.nextCaseNumber) || 1
        };

        console.log('STAK database loaded.');
    } catch (error) {
        console.error(
            'Could not load stak-data.json:',
            error
        );
    }
}

function saveData() {
    try {
        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(data, null, 2),
            'utf8'
        );
    } catch (error) {
        console.error(
            'Could not save stak-data.json:',
            error
        );
    }
}

// ============================================================
// CLIENT
// ============================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

// ============================================================
// COMMANDS
// ============================================================

const commands = [

    new SlashCommandBuilder()
        .setName('staffpanel')
        .setDescription(
            'Create the STAK Staff Status Panel.'
        ),

    new SlashCommandBuilder()
        .setName('showstats')
        .setDescription(
            'Show administration activity statistics.'
        )
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription(
                    'Select a staff member.'
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('casepanel')
        .setDescription(
            'Create the STAK Staff Case Management Panel.'
        )

].map(command => command.toJSON());

// ============================================================
// TIME FUNCTIONS
// ============================================================

function formatTime(milliseconds) {

    if (
        !milliseconds ||
        milliseconds < 0
    ) {
        return '0h 0m';
    }

    const totalMinutes =
        Math.floor(
            milliseconds / 60000
        );

    const hours =
        Math.floor(
            totalMinutes / 60
        );

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

    const day =
        date.getDay();

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

    const date =
        new Date();

    return `${date.getFullYear()}-${String(
        date.getMonth() + 1
    ).padStart(2, '0')}`;
}

function nowString() {

    return new Date()
        .toLocaleString(
            'en-GB'
        );
}

// ============================================================
// PERMISSIONS
// ============================================================

function isAdministrator(interaction) {

    return Boolean(
        interaction.memberPermissions &&
        interaction.memberPermissions.has(
            PermissionFlagsBits.Administrator
        )
    );
}

// ============================================================
// STAFF DATA
// ============================================================

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

function getCurrentShiftTime(staff) {

    if (
        !staff.inDuty ||
        staff.onBreak ||
        !staff.shiftStart
    ) {
        return 0;
    }

    return (
        Date.now() -
        staff.shiftStart
    );
}

function saveCurrentShift(userId) {

    const staff =
        getStaff(userId);

    if (
        !staff.inDuty ||
        staff.onBreak ||
        !staff.shiftStart
    ) {
        return;
    }

    const elapsed =
        Date.now() -
        staff.shiftStart;

    const today =
        dateKey();

    const week =
        weekKey();

    const month =
        monthKey();

    staff.daily[today] =
        (staff.daily[today] || 0) +
        elapsed;

    staff.weekly[week] =
        (staff.weekly[week] || 0) +
        elapsed;

    staff.monthly[month] =
        (staff.monthly[month] || 0) +
        elapsed;

    staff.shiftStart =
        Date.now();

    saveData();
}

function getActiveStaff() {

    return Object.entries(
        data.staff
    ).filter(
        ([, staff]) =>
            staff.inDuty &&
            !staff.onBreak
    );
}

// ============================================================
// STAFF PANEL
// ============================================================

function createStaffEmbed() {

    const active =
        getActiveStaff();

    let staffList = '';

    if (active.length === 0) {

        staffList =
            '🔴 **No staff members are currently In Duty.**';

    } else {

        for (
            const [userId, staff]
            of active
        ) {

            staffList +=
                `🟢 <@${userId}> — **${formatTime(
                    getCurrentShiftTime(staff)
                )}**\n`;
        }
    }

    const status =
        active.length >= 3
            ? `🟢 **${active.length} Staff In Duty**`
            : `🔴 **${active.length}/3 Staff In Duty**`;

    return new EmbedBuilder()

        .setTitle(
            '🛡️ STAK | Staff Status'
        )

        .setDescription(

            `### Administration Status\n` +

            `${status}\n\n` +

            `### Currently In Duty\n` +

            `${staffList}\n\n` +

            `Staff members currently **In Duty** are handling administration.\n` +

            `Staff members on **Break** or **Out Duty** are not counted.\n\n` +

            `Use the buttons below to manage your administration status.`
        )

        .setFooter({
            text:
                'STAK • No One Stands Alone'
        })

        .setTimestamp();
}

function createStaffButtons() {

    return new ActionRowBuilder()

        .addComponents(

            new ButtonBuilder()
                .setCustomId(
                    'staff_in'
                )
                .setLabel(
                    'Go In Duty'
                )
                .setEmoji(
                    '🟢'
                )
                .setStyle(
                    ButtonStyle.Success
                ),

            new ButtonBuilder()
                .setCustomId(
                    'staff_break'
                )
                .setLabel(
                    'Break'
                )
                .setEmoji(
                    '⏸️'
                )
                .setStyle(
                    ButtonStyle.Secondary
                ),

            new ButtonBuilder()
                .setCustomId(
                    'staff_out'
                )
                .setLabel(
                    'Go Out Duty'
                )
                .setEmoji(
                    '🔴'
                )
                .setStyle(
                    ButtonStyle.Danger
                )
        );
}

async function updateStaffPanel(message = null) {

    try {

        let targetMessage = message;

        if (!targetMessage) {

            if (
                !data.activityPanelChannelId ||
                !data.activityPanelMessageId
            ) {
                console.log(
                    '⚠️ Staff panel IDs are not saved yet.'
                );
                return;
            }

            const channel =
                await client.channels.fetch(
                    data.activityPanelChannelId
                );

            if (!channel) {
                return;
            }

            targetMessage =
                await channel.messages.fetch(
                    data.activityPanelMessageId
                );
        }

        await targetMessage.edit({

            embeds: [
                createStaffEmbed()
            ],

            components: [
                createStaffButtons()
            ]
        });

        console.log(
            '✅ Staff Status Panel updated.'
        );

    } catch (error) {

        console.error(
            '❌ Staff panel update failed:',
            error.message
        );
    }
}

// ============================================================
// CASE PANEL
// ============================================================

function createCasePanelEmbed() {

    return new EmbedBuilder()

        .setTitle(
            '📁 STAK | Case Management'
        )

        .setDescription(

            '**Player Records & Case Management**\n\n' +

            'Create, search and manage official player records and moderation cases.\n\n' +

            '📁 **Create Player Record**\n' +
            'Create a new player record. Existing records cannot be duplicated.\n\n' +

            '🔎 **Search Player**\n' +
            'Search all existing player records by In-Game or Discord username.\n\n' +

            '✏️ **Edit Case**\n' +
            'Find a player and select one of their cases to edit.\n\n' +

            '➕ **Add Case**\n' +
            'Add additional moderation cases to an existing player record.\n\n' +

            '🗑️ **Delete Player Record**\n' +
            'Only members with the Discord **Administrator** permission can permanently delete a complete player record and its cases.\n\n' +

            '**Permissions**\n' +
            'Everyone can create records and cases. Staff members can edit only cases they created. Discord Administrators can edit any case and delete complete player records.\n\n' +

            'All searches and records opened through the system are shown privately to the staff member using them.'
        )

        .setFooter({

            text:
                'STAK Case Management • No One Stands Alone'

        })

        .setTimestamp();
}

function createCasePanelButtons() {

    return new ActionRowBuilder()

        .addComponents(

            new ButtonBuilder()
                .setCustomId(
                    'case_create'
                )
                .setLabel(
                    'Create Player Record'
                )
                .setEmoji(
                    '📁'
                )
                .setStyle(
                    ButtonStyle.Success
                ),

            new ButtonBuilder()
                .setCustomId(
                    'case_search'
                )
                .setLabel(
                    'Search Player'
                )
                .setEmoji(
                    '🔎'
                )
                .setStyle(
                    ButtonStyle.Primary
                ),

            new ButtonBuilder()
                .setCustomId(
                    'case_edit'
                )
                .setLabel(
                    'Edit Case'
                )
                .setEmoji(
                    '✏️'
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
        );
}

// ============================================================
// CASE NUMBER
// ============================================================

function generateCaseNumber() {

    const number =
        data.nextCaseNumber;

    data.nextCaseNumber++;

    saveData();

    return `STAK-${String(
        number
    ).padStart(4, '0')}`;
}

// ============================================================
// PLAYER SYSTEM
// ============================================================

function playerKey(
    ingameUsername,
    discordUsername
) {

    return (
        `${ingameUsername
            .trim()
            .toLowerCase()}::` +

        `${discordUsername
            .trim()
            .toLowerCase()}`
    );
}

function getAllPlayers() {

    return Object.entries(
        data.players
    )
        .map(
            ([id, player]) => ({
                id,
                player
            })
        )
        .sort(
            (a, b) =>
                (
                    a.player.ingameUsername || ''
                ).localeCompare(
                    b.player.ingameUsername || '',
                    undefined,
                    {
                        sensitivity:
                            'base'
                    }
                )
        );
}

function searchPlayers(search) {

    const value =
        search
            .trim()
            .toLowerCase();

    return getAllPlayers()
        .filter(
            ({ player }) => {

                if (!value) {
                    return true;
                }

                return (

                    (
                        player.ingameUsername ||
                        ''
                    )
                        .toLowerCase()
                        .includes(value)

                    ||

                    (
                        player.discordUsername ||
                        ''
                    )
                        .toLowerCase()
                        .includes(value)
                );
            }
        );
}

// ============================================================
// PLAYER EMBED
// ============================================================

function createPlayerEmbed(player) {

    let casesText = '';

    if (
        !player.cases ||
        player.cases.length === 0
    ) {

        casesText =
            'No cases recorded yet.';

    } else {

        const recentCases =
            player.cases
                .slice()
                .reverse()
                .slice(
                    0,
                    10
                );

        for (
            const item
            of recentCases
        ) {

            casesText +=

                `**${item.caseNumber}** • ` +

                `**${item.type}** • ` +

                `${item.game}\n` +

                `Action / Outcome: ${item.action}\n` +

                `Reason: ${item.reason}\n` +

                `Notes: ${item.notes || 'None'}\n` +

                `Created by: <@${item.createdById}>\n` +

                `Date: ${item.date}\n`;

            if (
                item.lastEditedById
            ) {

                casesText +=
                    `Last edited by: <@${item.lastEditedById}> — ${item.lastEditedAt}\n`;
            }

            casesText += '\n';
        }

        if (
            player.cases.length > 10
        ) {

            casesText +=
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

            `**Record Created By:** <@${player.createdById}>\n` +

            `**Total Cases:** ${player.cases?.length || 0}\n\n` +

            `### Case History\n` +

            casesText
        )

        .setFooter({

            text:
                'STAK Player Record'

        })

        .setTimestamp();
}

// ============================================================
// PLAYER BUTTONS
// ============================================================

function createPlayerButtons(
    playerId,
    interaction
) {

    const admin =
        isAdministrator(interaction);

    const row =
        new ActionRowBuilder()

        .addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `player_add|${playerId}`
                )
                .setLabel(
                    'Add Case'
                )
                .setEmoji(
                    '➕'
                )
                .setStyle(
                    ButtonStyle.Success
                ),

            new ButtonBuilder()
                .setCustomId(
                    `player_edit|${playerId}`
                )
                .setLabel(
                    'Edit Case'
                )
                .setEmoji(
                    '✏️'
                )
                .setStyle(
                    ButtonStyle.Secondary
                ),

            new ButtonBuilder()
                .setCustomId(
                    'player_close'
                )
                .setLabel(
                    'Close'
                )
                .setEmoji(
                    '✖️'
                )
                .setStyle(
                    ButtonStyle.Danger
                )
        );

    if (admin) {

        row.addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `player_delete|${playerId}`
                )
                .setLabel(
                    'Delete Record'
                )
                .setEmoji(
                    '🗑️'
                )
                .setStyle(
                    ButtonStyle.Danger
                )
        );
    }

    return row;
}

// ============================================================
// DELETE CONFIRMATION BUTTONS
// ============================================================

function createDeleteConfirmationButtons(
    playerId
) {

    return new ActionRowBuilder()

        .addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `delete_confirm|${playerId}`
                )
                .setLabel(
                    'Permanently Delete'
                )
                .setEmoji(
                    '🗑️'
                )
                .setStyle(
                    ButtonStyle.Danger
                ),

            new ButtonBuilder()
                .setCustomId(
                    'player_close'
                )
                .setLabel(
                    'Cancel'
                )
                .setEmoji(
                    '✖️'
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
        );
}

// ============================================================
// CREATE PLAYER MODAL
// ============================================================

function createPlayerModal() {

    return new ModalBuilder()

        .setCustomId(
            'create_player_modal'
        )

        .setTitle(
            'Create Player Record'
        )

        .addComponents(

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'ingame_username'
                        )
                        .setLabel(
                            'In-Game Username'
                        )
                        .setPlaceholder(
                            'Enter the player name'
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setRequired(
                            true
                        )
                        .setMaxLength(
                            100
                        )
                ),

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'discord_username'
                        )
                        .setLabel(
                            'Discord Username'
                        )
                        .setPlaceholder(
                            'Enter the Discord username'
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setRequired(
                            true
                        )
                        .setMaxLength(
                            100
                        )
                ),

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'notes'
                        )
                        .setLabel(
                            'Initial Notes'
                        )
                        .setPlaceholder(
                            'Optional'
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setRequired(
                            false
                        )
                        .setMaxLength(
                            1000
                        )
                )
        );
}

// ============================================================
// ADD CASE MODAL
// ============================================================

function createAddCaseModal(
    playerId
) {

    return new ModalBuilder()

        .setCustomId(
            `add_case|${playerId}`
        )

        .setTitle(
            'Add New Case'
        )

        .addComponents(

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'game'
                        )
                        .setLabel(
                            'Game / Server'
                        )
                        .setPlaceholder(
                            'Roblox / Armory Forge / Ready or Not'
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setRequired(
                            true
                        )
                        .setMaxLength(
                            100
                        )
                ),

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'type'
                        )
                        .setLabel(
                            'Case Type'
                        )
                        .setPlaceholder(
                            'Warning / Kick / Ban / Note / Other'
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setRequired(
                            true
                        )
                        .setMaxLength(
                            50
                        )
                ),

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'action'
                        )
                        .setLabel(
                            'Action / Outcome'
                        )
                        .setPlaceholder(
                            'What action was taken?'
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setRequired(
                            true
                        )
                        .setMaxLength(
                            500
                        )
                ),

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'reason'
                        )
                        .setLabel(
                            'Reason'
                        )
                        .setPlaceholder(
                            'Why was the action taken?'
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setRequired(
                            true
                        )
                        .setMaxLength(
                            1500
                        )
                ),

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'notes'
                        )
                        .setLabel(
                            'Duration / Evidence / Notes'
                        )
                        .setPlaceholder(
                            'Ban duration, evidence, additional notes...'
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setRequired(
                            false
                        )
                        .setMaxLength(
                            1500
                        )
                )
        );
}

// ============================================================
// EDIT CASE MODAL
// ============================================================

function createEditCaseModal(
    playerId,
    caseNumber
) {

    const player =
        data.players[playerId];

    if (!player) {
        return null;
    }

    const currentCase =
        (player.cases || []).find(
            item =>
                item.caseNumber ===
                caseNumber
        );

    if (!currentCase) {
        return null;
    }

    return new ModalBuilder()

        .setCustomId(
            `edit_case|${playerId}|${caseNumber}`
        )

        .setTitle(
            `Edit ${caseNumber}`
        )

        .addComponents(

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'game'
                        )
                        .setLabel(
                            'Game / Server'
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setRequired(
                            true
                        )
                        .setMaxLength(
                            100
                        )
                        .setValue(
                            currentCase.game || ''
                        )
                ),

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'type'
                        )
                        .setLabel(
                            'Case Type'
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setRequired(
                            true
                        )
                        .setMaxLength(
                            50
                        )
                        .setValue(
                            currentCase.type || ''
                        )
                ),

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'action'
                        )
                        .setLabel(
                            'Action / Outcome'
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setRequired(
                            true
                        )
                        .setMaxLength(
                            500
                        )
                        .setValue(
                            currentCase.action || ''
                        )
                ),

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'reason'
                        )
                        .setLabel(
                            'Reason'
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setRequired(
                            true
                        )
                        .setMaxLength(
                            1500
                        )
                        .setValue(
                            currentCase.reason || ''
                        )
                ),

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'notes'
                        )
                        .setLabel(
                            'Duration / Evidence / Notes'
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setRequired(
                            false
                        )
                        .setMaxLength(
                            1500
                        )
                        .setValue(
                            currentCase.notes || ''
                        )
                )
        );
}

// ============================================================
// SEARCH PLAYER MODAL
// ============================================================

function searchPlayerModal(
    mode
) {

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

            new ActionRowBuilder()
                .addComponents(

                    new TextInputBuilder()
                        .setCustomId(
                            'search'
                        )
                        .setLabel(
                            'Player Name'
                        )
                        .setPlaceholder(
                            'Leave empty to browse all players'
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setRequired(
                            false
                        )
                        .setMaxLength(
                            100
                        )
                )
        );
}

// ============================================================
// PLAYER SELECT MENU
// ============================================================

function createPlayerSelectMenu(
    players,
    page,
    mode
) {

    const start =
        page *
        PLAYERS_PER_PAGE;

    const pagePlayers =
        players.slice(
            start,
            start + PLAYERS_PER_PAGE
        );

    if (
        pagePlayers.length === 0
    ) {
        return null;
    }

    return new StringSelectMenuBuilder()

        .setCustomId(
            `select_player|${mode}|${page}`
        )

        .setPlaceholder(
            'Select a player'
        )

        .addOptions(

            pagePlayers.map(
                ({ id, player }) => ({

                    label:
                        (
                            player.ingameUsername ||
                            'Unknown Player'
                        ).slice(
                            0,
                            100
                        ),

                    description:
                        (
                            `${player.discordUsername || 'No Discord'} • ${player.cases?.length || 0} Cases`
                        ).slice(
                            0,
                            100
                        ),

                    value:
                        id
                })
            )
        );
}

// ============================================================
// PLAYER SEARCH NAVIGATION
// ============================================================

function createPlayerNavigation(
    mode,
    page,
    totalPages
) {

    const row =
        new ActionRowBuilder();

    if (
        page > 0
    ) {

        row.addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `player_prev|${mode}|${page - 1}`
                )
                .setLabel(
                    'Previous'
                )
                .setEmoji(
                    '◀️'
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
        );
    }

    row.addComponents(

        new ButtonBuilder()
            .setCustomId(
                'player_close'
            )
            .setLabel(
                'Close'
            )
            .setEmoji(
                '✖️'
            )
            .setStyle(
                ButtonStyle.Danger
            )
    );

    if (
        page <
        totalPages - 1
    ) {

        row.addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `player_next|${mode}|${page + 1}`
                )
                .setLabel(
                    'Next'
                )
                .setEmoji(
                    '▶️'
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
        );
    }

    return row;
}

// ============================================================
// CASE SELECT MENU
// ============================================================

function createCaseSelectMenu(
    playerId,
    page = 0,
    interaction
) {

    const player =
        data.players[playerId];

    const cases =
        player?.cases || [];

    const start =
        page *
        CASES_PER_PAGE;

    const pageCases =
        cases.slice(
            start,
            start + CASES_PER_PAGE
        );

    if (
        pageCases.length === 0
    ) {
        return null;
    }

    const admin =
        isAdministrator(interaction);

    const editableCases =
        pageCases.filter(
            item =>
                admin ||
                item.createdById ===
                interaction.user.id
        );

    if (
        editableCases.length === 0
    ) {
        return null;
    }

    return new StringSelectMenuBuilder()

        .setCustomId(
            `select_case|${playerId}|${page}`
        )

        .setPlaceholder(
            'Select one of your cases to edit'
        )

        .addOptions(

            editableCases.map(
                item => ({

                    label:
                        `${item.caseNumber} • ${item.type}`
                            .slice(
                                0,
                                100
                            ),

                    description:
                        `${item.game} • ${item.reason}`
                            .slice(
                                0,
                                100
                            ),

                    value:
                        item.caseNumber
                })
            )
        );
}

// ============================================================
// CASE NAVIGATION
// ============================================================

function createCaseNavigation(
    playerId,
    page,
    totalPages
) {

    const row =
        new ActionRowBuilder();

    if (
        page > 0
    ) {

        row.addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `case_prev|${playerId}|${page - 1}`
                )
                .setLabel(
                    'Previous'
                )
                .setEmoji(
                    '◀️'
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
        );
    }

    row.addComponents(

        new ButtonBuilder()
            .setCustomId(
                `player_add|${playerId}`
            )
            .setLabel(
                'Add Case'
            )
            .setEmoji(
                '➕'
            )
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
            .setEmoji(
                '✖️'
            )
            .setStyle(
                ButtonStyle.Danger
            )
    );

    if (
        page <
        totalPages - 1
    ) {

        row.addComponents(

            new ButtonBuilder()
                .setCustomId(
                    `case_next|${playerId}|${page + 1}`
                )
                .setLabel(
                    'Next'
                )
                .setEmoji(
                    '▶️'
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
        );
    }

    return row;
}

// ============================================================
// READY
// ============================================================

client.once(
    'clientReady',
    async () => {

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
    }
);

// ============================================================
// REGISTER COMMANDS
// ============================================================

async function registerCommands() {

    if (!GUILD_ID) {

        console.error(
            '❌ GUILD_ID is missing from .env'
        );

        return;
    }

    const rest =
        new REST({
            version: '10'
        }).setToken(
            TOKEN
        );

    try {

        await rest.put(

            Routes.applicationGuildCommands(
                client.user.id,
                GUILD_ID
            ),

            {
                body:
                    commands
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

// ============================================================
// INTERACTIONS
// ============================================================

client.on(
    'interactionCreate',
    async interaction => {

        try {

            // ==================================================
            // SLASH COMMANDS
            // ==================================================

            if (
                interaction.isChatInputCommand()
            ) {

                // ----------------------------------------------
                // STAFF PANEL
                // ----------------------------------------------

                if (
                    interaction.commandName ===
                    'staffpanel'
                ) {

                    const message =
                        await interaction.channel.send({

                            embeds: [
                                createStaffEmbed()
                            ],

                            components: [
                                createStaffButtons()
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

                        ephemeral:
                            true

                    });

                    return;
                }

                // ----------------------------------------------
                // SHOW STATS
                // ----------------------------------------------

                if (
                    interaction.commandName ===
                    'showstats'
                ) {

                    const user =
                        interaction.options.getUser(
                            'user'
                        );

                    const staff =
                        getStaff(
                            user.id
                        );

                    const today =
                        dateKey();

                    const week =
                        weekKey();

                    const month =
                        monthKey();

                    let todayTime =
                        staff.daily[today] ||
                        0;

                    let weekTime =
                        staff.weekly[week] ||
                        0;

                    let monthTime =
                        staff.monthly[month] ||
                        0;

                    const current =
                        getCurrentShiftTime(
                            staff
                        );

                    if (
                        staff.inDuty &&
                        !staff.onBreak
                    ) {

                        todayTime +=
                            current;

                        weekTime +=
                            current;

                        monthTime +=
                            current;
                    }

                    const embed =
                        new EmbedBuilder()

                            .setTitle(
                                `📊 Staff Statistics | ${user.username}`
                            )

                            .setDescription(

                                `### Today\n` +

                                `**${formatTime(
                                    todayTime
                                )}**\n\n` +

                                `### This Week\n` +

                                `**${formatTime(
                                    weekTime
                                )}**\n\n` +

                                `### This Month\n` +

                                `**${formatTime(
                                    monthTime
                                )}**\n\n` +

                                `### Total Shifts\n` +

                                `**${staff.shifts || 0}**`
                            )

                            .setFooter({

                                text:
                                    'STAK Staff Statistics'

                            })

                            .setTimestamp();

                    await interaction.reply({

                        embeds: [
                            embed
                        ],

                        ephemeral:
                            true

                    });

                    return;
                }

                // ----------------------------------------------
                // CASE PANEL
                // ----------------------------------------------

                if (
                    interaction.commandName ===
                    'casepanel'
                ) {

                    const message =
                        await interaction.channel.send({

                            embeds: [
                                createCasePanelEmbed()
                            ],

                            components: [
                                createCasePanelButtons()
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

                        ephemeral:
                            true

                    });

                    return;
                }
            }

            // ==================================================
            // BUTTONS
            // ==================================================

            if (
                interaction.isButton()
            ) {

                // ----------------------------------------------
                // STAFF IN
                // ----------------------------------------------

                if (
                    interaction.customId ===
                    'staff_in'
                ) {

                    const staff =
                        getStaff(
                            interaction.user.id
                        );

                    if (
                        staff.inDuty
                    ) {

                        await interaction.reply({

                            content:
                                '⚠️ You are already In Duty.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    staff.inDuty =
                        true;

                    staff.onBreak =
                        false;

                    staff.shiftStart =
                        Date.now();

                    staff.shifts =
                        (staff.shifts || 0) +
                        1;

                    saveData();

                    // Directly edit the exact panel
                    // the user clicked.
                    await updateStaffPanel(
                        interaction.message
                    );

                    await interaction.reply({

                        content:
                            '🟢 You are now **In Duty**.',

                        ephemeral:
                            true

                    });

                    return;
                }

                // ----------------------------------------------
                // STAFF BREAK
                // ----------------------------------------------

                if (
                    interaction.customId ===
                    'staff_break'
                ) {

                    const staff =
                        getStaff(
                            interaction.user.id
                        );

                    if (
                        !staff.inDuty
                    ) {

                        await interaction.reply({

                            content:
                                '⚠️ You are not currently In Duty.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    if (
                        staff.onBreak
                    ) {

                        staff.onBreak =
                            false;

                        staff.shiftStart =
                            Date.now();

                        saveData();

                        await updateStaffPanel(
                            interaction.message
                        );

                        await interaction.reply({

                            content:
                                '🟢 You are back **In Duty**.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    saveCurrentShift(
                        interaction.user.id
                    );

                    staff.onBreak =
                        true;

                    saveData();

                    await updateStaffPanel(
                        interaction.message
                    );

                    await interaction.reply({

                        content:
                            '⏸️ You are now on **Break**.',

                        ephemeral:
                            true

                    });

                    return;
                }

                // ----------------------------------------------
                // STAFF OUT
                // ----------------------------------------------

                if (
                    interaction.customId ===
                    'staff_out'
                ) {

                    const staff =
                        getStaff(
                            interaction.user.id
                        );

                    if (
                        !staff.inDuty
                    ) {

                        await interaction.reply({

                            content:
                                '⚠️ You are not currently In Duty.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    if (
                        !staff.onBreak
                    ) {

                        saveCurrentShift(
                            interaction.user.id
                        );
                    }

                    staff.inDuty =
                        false;

                    staff.onBreak =
                        false;

                    staff.shiftStart =
                        null;

                    saveData();

                    await updateStaffPanel(
                        interaction.message
                    );

                    await interaction.reply({

                        content:
                            '🔴 You are now **Out Duty**.',

                        ephemeral:
                            true

                    });

                    return;
                }

                // ----------------------------------------------
                // CREATE PLAYER
                // ----------------------------------------------

                if (
                    interaction.customId ===
                    'case_create'
                ) {

                    await interaction.showModal(
                        createPlayerModal()
                    );

                    return;
                }

                // ----------------------------------------------
                // SEARCH PLAYER
                // ----------------------------------------------

                if (
                    interaction.customId ===
                    'case_search'
                ) {

                    await interaction.showModal(
                        searchPlayerModal(
                            'search'
                        )
                    );

                    return;
                }

                // ----------------------------------------------
                // EDIT CASE
                // ----------------------------------------------

                if (
                    interaction.customId ===
                    'case_edit'
                ) {

                    await interaction.showModal(
                        searchPlayerModal(
                            'edit'
                        )
                    );

                    return;
                }

                // ----------------------------------------------
                // PLAYER PREVIOUS
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'player_prev|'
                    )
                ) {

                    const parts =
                        interaction.customId.split(
                            '|'
                        );

                    const mode =
                        parts[1];

                    const page =
                        Number(
                            parts[2]
                        );

                    const players =
                        getAllPlayers();

                    const totalPages =
                        Math.max(
                            1,
                            Math.ceil(
                                players.length /
                                PLAYERS_PER_PAGE
                            )
                        );

                    const safePage =
                        Math.max(
                            0,
                            Math.min(
                                page,
                                totalPages - 1
                            )
                        );

                    const menu =
                        createPlayerSelectMenu(
                            players,
                            safePage,
                            mode
                        );

                    const components = [];

                    if (menu) {

                        components.push(

                            new ActionRowBuilder()
                                .addComponents(
                                    menu
                                )
                        );
                    }

                    components.push(

                        createPlayerNavigation(
                            mode,
                            safePage,
                            totalPages
                        )
                    );

                    await interaction.update({

                        content:
                            `🔎 **${players.length} player(s) found.**`,

                        components

                    });

                    return;
                }

                // ----------------------------------------------
                // PLAYER NEXT
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'player_next|'
                    )
                ) {

                    const parts =
                        interaction.customId.split(
                            '|'
                        );

                    const mode =
                        parts[1];

                    const page =
                        Number(
                            parts[2]
                        );

                    const players =
                        getAllPlayers();

                    const totalPages =
                        Math.max(
                            1,
                            Math.ceil(
                                players.length /
                                PLAYERS_PER_PAGE
                            )
                        );

                    const safePage =
                        Math.max(
                            0,
                            Math.min(
                                page,
                                totalPages - 1
                            )
                        );

                    const menu =
                        createPlayerSelectMenu(
                            players,
                            safePage,
                            mode
                        );

                    const components = [];

                    if (menu) {

                        components.push(

                            new ActionRowBuilder()
                                .addComponents(
                                    menu
                                )
                        );
                    }

                    components.push(

                        createPlayerNavigation(
                            mode,
                            safePage,
                            totalPages
                        )
                    );

                    await interaction.update({

                        content:
                            `🔎 **${players.length} player(s) found.**`,

                        components

                    });

                    return;
                }

                // ----------------------------------------------
                // ADD CASE
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'player_add|'
                    )
                ) {

                    const playerId =
                        interaction.customId.split(
                            '|'
                        )[1];

                    if (
                        !data.players[playerId]
                    ) {

                        await interaction.reply({

                            content:
                                '❌ Player record not found.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    await interaction.showModal(
                        createAddCaseModal(
                            playerId
                        )
                    );

                    return;
                }

                // ----------------------------------------------
                // EDIT PLAYER CASES
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'player_edit|'
                    )
                ) {

                    const playerId =
                        interaction.customId.split(
                            '|'
                        )[1];

                    const player =
                        data.players[playerId];

                    if (!player) {

                        await interaction.reply({

                            content:
                                '❌ Player record not found.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const cases =
                        player.cases || [];

                    if (
                        cases.length === 0
                    ) {

                        await interaction.reply({

                            content:
                                'ℹ️ This player has no cases to edit.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const admin =
                        isAdministrator(
                            interaction
                        );

                    const editableCases =
                        cases.filter(
                            item =>
                                admin ||
                                item.createdById ===
                                interaction.user.id
                        );

                    if (
                        editableCases.length === 0
                    ) {

                        await interaction.reply({

                            content:
                                '🔒 You can only edit cases that you created yourself.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const totalPages =
                        Math.max(
                            1,
                            Math.ceil(
                                cases.length /
                                CASES_PER_PAGE
                            )
                        );

                    const caseMenu =
                        createCaseSelectMenu(
                            playerId,
                            0,
                            interaction
                        );

                    const components = [];

                    if (
                        caseMenu
                    ) {

                        components.push(

                            new ActionRowBuilder()
                                .addComponents(
                                    caseMenu
                                )
                        );
                    }

                    components.push(

                        createCaseNavigation(
                            playerId,
                            0,
                            totalPages
                        )
                    );

                    await interaction.reply({

                        content:
                            admin
                                ? `✏️ **Select a Case to Edit**\nPlayer: **${player.ingameUsername}**\n\n🔑 You have Administrator permission and can edit all cases.`
                                : `✏️ **Select one of your Cases to Edit**\nPlayer: **${player.ingameUsername}**`,

                        embeds: [
                            createPlayerEmbed(
                                player
                            )
                        ],

                        components,

                        ephemeral:
                            true

                    });

                    return;
                }

                // ----------------------------------------------
                // CASE PREVIOUS
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'case_prev|'
                    )
                ) {

                    const parts =
                        interaction.customId.split(
                            '|'
                        );

                    const playerId =
                        parts[1];

                    const page =
                        Number(
                            parts[2]
                        );

                    const player =
                        data.players[playerId];

                    if (!player) {

                        await interaction.reply({

                            content:
                                '❌ Player not found.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const totalPages =
                        Math.max(
                            1,
                            Math.ceil(
                                (player.cases || []).length /
                                CASES_PER_PAGE
                            )
                        );

                    const safePage =
                        Math.max(
                            0,
                            Math.min(
                                page,
                                totalPages - 1
                            )
                        );

                    const caseMenu =
                        createCaseSelectMenu(
                            playerId,
                            safePage,
                            interaction
                        );

                    const components = [];

                    if (
                        caseMenu
                    ) {

                        components.push(

                            new ActionRowBuilder()
                                .addComponents(
                                    caseMenu
                                )
                        );
                    }

                    components.push(

                        createCaseNavigation(
                            playerId,
                            safePage,
                            totalPages
                        )
                    );

                    await interaction.update({

                        components

                    });

                    return;
                }

                // ----------------------------------------------
                // CASE NEXT
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'case_next|'
                    )
                ) {

                    const parts =
                        interaction.customId.split(
                            '|'
                        );

                    const playerId =
                        parts[1];

                    const page =
                        Number(
                            parts[2]
                        );

                    const player =
                        data.players[playerId];

                    if (!player) {

                        await interaction.reply({

                            content:
                                '❌ Player not found.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const totalPages =
                        Math.max(
                            1,
                            Math.ceil(
                                (player.cases || []).length /
                                CASES_PER_PAGE
                            )
                        );

                    const safePage =
                        Math.max(
                            0,
                            Math.min(
                                page,
                                totalPages - 1
                            )
                        );

                    const caseMenu =
                        createCaseSelectMenu(
                            playerId,
                            safePage,
                            interaction
                        );

                    const components = [];

                    if (
                        caseMenu
                    ) {

                        components.push(

                            new ActionRowBuilder()
                                .addComponents(
                                    caseMenu
                                )
                        );
                    }

                    components.push(

                        createCaseNavigation(
                            playerId,
                            safePage,
                            totalPages
                        )
                    );

                    await interaction.update({

                        components

                    });

                    return;
                }

                // ----------------------------------------------
                // DELETE PLAYER RECORD
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'player_delete|'
                    )
                ) {

                    if (
                        !isAdministrator(
                            interaction
                        )
                    ) {

                        await interaction.reply({

                            content:
                                '🔒 Only members with the Discord **Administrator** permission can delete player records.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const playerId =
                        interaction.customId.split(
                            '|'
                        )[1];

                    const player =
                        data.players[playerId];

                    if (!player) {

                        await interaction.reply({

                            content:
                                '❌ Player record not found.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    await interaction.update({

                        content:
                            `⚠️ **Permanent Deletion Confirmation**\n\nYou are about to permanently delete the complete player record of **${player.ingameUsername}**.\n\nThis includes **${player.cases?.length || 0} case(s)** and cannot be undone.`,

                        embeds: [],

                        components: [
                            createDeleteConfirmationButtons(
                                playerId
                            )
                        ]

                    });

                    return;
                }

                // ----------------------------------------------
                // CONFIRM DELETE
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'delete_confirm|'
                    )
                ) {

                    if (
                        !isAdministrator(
                            interaction
                        )
                    ) {

                        await interaction.reply({

                            content:
                                '🔒 Only Discord Administrators can delete records.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const playerId =
                        interaction.customId.split(
                            '|'
                        )[1];

                    const player =
                        data.players[playerId];

                    if (!player) {

                        await interaction.update({

                            content:
                                '❌ Player record no longer exists.',

                            embeds: [],

                            components: []

                        });

                        return;
                    }

                    const playerName =
                        player.ingameUsername;

                    const caseCount =
                        player.cases?.length || 0;

                    delete data.players[playerId];

                    saveData();

                    await interaction.update({

                        content:
                            `🗑️ **Player Record Deleted**\n\n**${playerName}** and all **${caseCount} case(s)** have been permanently deleted by <@${interaction.user.id}>.`,

                        embeds: [],

                        components: []

                    });

                    console.log(
                        `ADMIN DELETE: ${playerName} (${caseCount} cases) by ${interaction.user.tag}`
                    );

                    return;
                }

                // ----------------------------------------------
                // CLOSE
                // ----------------------------------------------

                if (
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

            // ==================================================
            // SELECT MENUS
            // ==================================================

            if (
                interaction.isStringSelectMenu()
            ) {

                // ----------------------------------------------
                // PLAYER SELECT
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'select_player|'
                    )
                ) {

                    const parts =
                        interaction.customId.split(
                            '|'
                        );

                    const mode =
                        parts[1];

                    const playerId =
                        interaction.values[0];

                    const player =
                        data.players[playerId];

                    if (!player) {

                        await interaction.update({

                            content:
                                '❌ Player not found.',

                            embeds: [],

                            components: []

                        });

                        return;
                    }

                    // SEARCH MODE
                    if (
                        mode ===
                        'search'
                    ) {

                        await interaction.update({

                            content:
                                `📁 **Player Record**\n**${player.ingameUsername}**`,

                            embeds: [
                                createPlayerEmbed(
                                    player
                                )
                            ],

                            components: [
                                createPlayerButtons(
                                    playerId,
                                    interaction
                                )
                            ]

                        });

                        return;
                    }

                    // EDIT MODE
                    if (
                        mode ===
                        'edit'
                    ) {

                        const cases =
                            player.cases || [];

                        if (
                            cases.length === 0
                        ) {

                            await interaction.update({

                                content:
                                    'ℹ️ This player has no cases to edit.',

                                embeds: [
                                    createPlayerEmbed(
                                        player
                                    )
                                ],

                                components: [
                                    createPlayerButtons(
                                        playerId,
                                        interaction
                                    )
                                ]

                            });

                            return;
                        }

                        const admin =
                            isAdministrator(
                                interaction
                            );

                        const editableCases =
                            cases.filter(
                                item =>
                                    admin ||
                                    item.createdById ===
                                    interaction.user.id
                            );

                        if (
                            editableCases.length === 0
                        ) {

                            await interaction.update({

                                content:
                                    '🔒 You do not have permission to edit any of this player\'s cases.',

                                embeds: [
                                    createPlayerEmbed(
                                        player
                                    )
                                ],

                                components: [
                                    createPlayerButtons(
                                        playerId,
                                        interaction
                                    )
                                ]

                            });

                            return;
                        }

                        const totalPages =
                            Math.max(
                                1,
                                Math.ceil(
                                    cases.length /
                                    CASES_PER_PAGE
                                )
                            );

                        const caseMenu =
                            createCaseSelectMenu(
                                playerId,
                                0,
                                interaction
                            );

                        const components = [];

                        if (
                            caseMenu
                        ) {

                            components.push(

                                new ActionRowBuilder()
                                    .addComponents(
                                        caseMenu
                                    )
                            );
                        }

                        components.push(

                            createCaseNavigation(
                                playerId,
                                0,
                                totalPages
                            )
                        );

                        await interaction.update({

                            content:
                                admin
                                    ? `✏️ **Select a Case to Edit**\nPlayer: **${player.ingameUsername}**\n\n🔑 Administrator access: all cases are available.`
                                    : `✏️ **Select one of your Cases to Edit**\nPlayer: **${player.ingameUsername}**`,

                            embeds: [
                                createPlayerEmbed(
                                    player
                                )
                            ],

                            components

                        });

                        return;
                    }
                }

                // ----------------------------------------------
                // CASE SELECT
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'select_case|'
                    )
                ) {

                    const parts =
                        interaction.customId.split(
                            '|'
                        );

                    const playerId =
                        parts[1];

                    const caseNumber =
                        interaction.values[0];

                    const player =
                        data.players[playerId];

                    if (!player) {

                        await interaction.update({

                            content:
                                '❌ Player not found.',

                            embeds: [],

                            components: []

                        });

                        return;
                    }

                    const selectedCase =
                        (player.cases || []).find(
                            item =>
                                item.caseNumber ===
                                caseNumber
                        );

                    if (!selectedCase) {

                        await interaction.update({

                            content:
                                '❌ Case not found.',

                            embeds: [],

                            components: []

                        });

                        return;
                    }

                    const admin =
                        isAdministrator(
                            interaction
                        );

                    const owner =
                        selectedCase.createdById ===
                        interaction.user.id;

                    if (
                        !admin &&
                        !owner
                    ) {

                        await interaction.reply({

                            content:
                                '🔒 You can only edit cases that you created yourself.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const modal =
                        createEditCaseModal(
                            playerId,
                            caseNumber
                        );

                    if (!modal) {

                        await interaction.reply({

                            content:
                                '❌ Could not open this case.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    await interaction.showModal(
                        modal
                    );

                    return;
                }
            }

            // ==================================================
            // MODALS
            // ==================================================

            if (
                interaction.isModalSubmit()
            ) {

                // ----------------------------------------------
                // CREATE PLAYER
                // ----------------------------------------------

                if (
                    interaction.customId ===
                    'create_player_modal'
                ) {

                    const ingameUsername =
                        interaction.fields
                            .getTextInputValue(
                                'ingame_username'
                            )
                            .trim();

                    const discordUsername =
                        interaction.fields
                            .getTextInputValue(
                                'discord_username'
                            )
                            .trim();

                    const notes =
                        interaction.fields
                            .getTextInputValue(
                                'notes'
                            )
                            .trim();

                    const key =
                        playerKey(
                            ingameUsername,
                            discordUsername
                        );

                    if (
                        data.players[key]
                    ) {

                        await interaction.reply({

                            content:
                                '⚠️ A player record with these names already exists. Use **Search Player** to open the existing record and add a new case instead.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    data.players[key] = {

                        ingameUsername,

                        discordUsername,

                        discordId:
                            interaction.user.id,

                        notes,

                        cases: [],

                        createdAt:
                            nowString(),

                        createdBy:
                            interaction.user.username,

                        createdById:
                            interaction.user.id
                    };

                    saveData();

                    await interaction.reply({

                        content:
                            `✅ Player record for **${ingameUsername}** has been created.`,

                        embeds: [
                            createPlayerEmbed(
                                data.players[key]
                            )
                        ],

                        components: [
                            createPlayerButtons(
                                key,
                                interaction
                            )
                        ],

                        ephemeral:
                            true

                    });

                    return;
                }

                // ----------------------------------------------
                // SEARCH PLAYER
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'search_player_'
                    )
                ) {

                    const mode =
                        interaction.customId.replace(
                            'search_player_',
                            ''
                        );

                    const search =
                        interaction.fields
                            .getTextInputValue(
                                'search'
                            )
                            .trim();

                    const players =
                        searchPlayers(
                            search
                        );

                    if (
                        players.length === 0
                    ) {

                        await interaction.reply({

                            content:
                                '❌ No players found.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const page =
                        0;

                    const totalPages =
                        Math.ceil(
                            players.length /
                            PLAYERS_PER_PAGE
                        );

                    const menu =
                        createPlayerSelectMenu(
                            players,
                            page,
                            mode
                        );

                    const components = [];

                    if (menu) {

                        components.push(

                            new ActionRowBuilder()
                                .addComponents(
                                    menu
                                )
                        );
                    }

                    components.push(

                        createPlayerNavigation(
                            mode,
                            page,
                            totalPages
                        )
                    );

                    await interaction.reply({

                        content:
                            `🔎 **${players.length} player(s) found.**\n\nPlayers are sorted alphabetically. Select a player below.`,

                        components,

                        ephemeral:
                            true

                    });

                    return;
                }

                // ----------------------------------------------
                // ADD CASE
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'add_case|'
                    )
                ) {

                    const parts =
                        interaction.customId.split(
                            '|'
                        );

                    const playerId =
                        parts[1];

                    const player =
                        data.players[playerId];

                    if (!player) {

                        await interaction.reply({

                            content:
                                '❌ Player record not found.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const game =
                        interaction.fields
                            .getTextInputValue(
                                'game'
                            )
                            .trim();

                    const type =
                        interaction.fields
                            .getTextInputValue(
                                'type'
                            )
                            .trim();

                    const action =
                        interaction.fields
                            .getTextInputValue(
                                'action'
                            )
                            .trim();

                    const reason =
                        interaction.fields
                            .getTextInputValue(
                                'reason'
                            )
                            .trim();

                    const notes =
                        interaction.fields
                            .getTextInputValue(
                                'notes'
                            )
                            .trim();

                    const caseNumber =
                        generateCaseNumber();

                    if (
                        !player.cases
                    ) {
                        player.cases = [];
                    }

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
                            nowString(),

                        date:
                            nowString()
                    });

                    saveData();

                    await interaction.reply({

                        content:
                            `✅ **${caseNumber}** has been added to **${player.ingameUsername}**.`,

                        embeds: [
                            createPlayerEmbed(
                                player
                            )
                        ],

                        components: [
                            createPlayerButtons(
                                playerId,
                                interaction
                            )
                        ],

                        ephemeral:
                            true

                    });

                    return;
                }

                // ----------------------------------------------
                // EDIT CASE
                // ----------------------------------------------

                if (
                    interaction.customId.startsWith(
                        'edit_case|'
                    )
                ) {

                    const parts =
                        interaction.customId.split(
                            '|'
                        );

                    const playerId =
                        parts[1];

                    const caseNumber =
                        parts[2];

                    const player =
                        data.players[playerId];

                    if (!player) {

                        await interaction.reply({

                            content:
                                '❌ Player record not found.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const selectedCase =
                        (player.cases || []).find(
                            item =>
                                item.caseNumber ===
                                caseNumber
                        );

                    if (!selectedCase) {

                        await interaction.reply({

                            content:
                                '❌ Case not found.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    const admin =
                        isAdministrator(
                            interaction
                        );

                    const owner =
                        selectedCase.createdById ===
                        interaction.user.id;

                    // SECURITY CHECK
                    if (
                        !admin &&
                        !owner
                    ) {

                        await interaction.reply({

                            content:
                                '🔒 Permission denied. You can only edit cases that you created yourself.',

                            ephemeral:
                                true

                        });

                        return;
                    }

                    selectedCase.game =
                        interaction.fields
                            .getTextInputValue(
                                'game'
                            )
                            .trim();

                    selectedCase.type =
                        interaction.fields
                            .getTextInputValue(
                                'type'
                            )
                            .trim();

                    selectedCase.action =
                        interaction.fields
                            .getTextInputValue(
                                'action'
                            )
                            .trim();

                    selectedCase.reason =
                        interaction.fields
                            .getTextInputValue(
                                'reason'
                            )
                            .trim();

                    selectedCase.notes =
                        interaction.fields
                            .getTextInputValue(
                                'notes'
                            )
                            .trim();

                    selectedCase.lastEditedBy =
                        interaction.user.username;

                    selectedCase.lastEditedById =
                        interaction.user.id;

                    selectedCase.lastEditedAt =
                        nowString();

                    saveData();

                    await interaction.reply({

                        content:
                            `✅ **${caseNumber}** has been updated successfully.`,

                        embeds: [
                            createPlayerEmbed(
                                player
                            )
                        ],

                        components: [
                            createPlayerButtons(
                                playerId,
                                interaction
                            )
                        ],

                        ephemeral:
                            true

                    });

                    return;
                }
            }

        } catch (error) {

            console.error(
                '❌ Interaction error:',
                error
            );

            if (
                !interaction.replied &&
                !interaction.deferred
            ) {

                try {

                    await interaction.reply({

                        content:
                            '❌ An unexpected error occurred. Check the bot console for details.',

                        ephemeral:
                            true

                    });

                } catch (replyError) {

                    console.error(
                        'Could not send error response:',
                        replyError
                    );
                }
            }
        }
    }
);

// ============================================================
// TOKEN CHECK
// ============================================================

if (!TOKEN) {

    console.error(
        '❌ DISCORD_TOKEN is missing from .env'
    );

    process.exit(
        1
    );
}

// ============================================================
// LOGIN
// ============================================================

client.login(
    TOKEN
);