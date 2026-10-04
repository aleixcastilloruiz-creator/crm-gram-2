"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCampaignRoutes = registerCampaignRoutes;
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("../telegram/connectionPool");
const sender_1 = require("../engine/sender");
const peerFlood_1 = require("../engine/peerFlood");
/**
 * Gestion de campañas: crear/editar/pausar/activar, y sus destinos.
 * IMPORTANTE (seguridad): activar una campaña (status ACTIVE) NO envia nada
 * por si sola si el interruptor maestro de la cuenta (reenviadorEnabled)
 * sigue apagado. El panel debe dejar esto claro en la interfaz.
 */
async function registerCampaignRoutes(app) {
    app.get("/api/accounts/:accountId/campaigns", async (request) => {
        const { accountId } = request.params;
        const campaigns = await prisma_1.prisma.campaign.findMany({
            where: { accountId },
            orderBy: { createdAt: "desc" },
            include: {
                sourceGroup: true,
                destinationChats: true,
                _count: { select: { destinationChats: true } },
            },
        });
        const lastSent = await prisma_1.prisma.sendLog.groupBy({
            by: ["campaignId"],
            where: { accountId, level: "SENT", campaignId: { in: campaigns.map((c) => c.id) } },
            _max: { createdAt: true },
        });
        const lastSentMap = new Map(lastSent.map((l) => [l.campaignId, l._max.createdAt]));
        return {
            campaigns: campaigns.map((c) => ({ ...c, lastSentAt: lastSentMap.get(c.id) ?? null })),
        };
    });
    app.get("/api/campaigns/:id", async (request) => {
        const { id } = request.params;
        const campaign = await prisma_1.prisma.campaign.findUniqueOrThrow({
            where: { id },
            include: { sourceGroup: true, destinationChats: true, account: true },
        });
        return { campaign };
    });
    app.post("/api/accounts/:accountId/campaigns", async (request) => {
        const { accountId } = request.params;
        const body = request.body;
        const campaign = await prisma_1.prisma.campaign.create({
            data: {
                accountId,
                sourceGroupId: body.sourceGroupId,
                folderName: body.folderName,
                status: "PAUSED", // las campañas nuevas siempre nacen en pausa, por seguridad
                sendMode: body.sendMode ?? "FORWARD_NO_AUTHOR",
                scheduleMode: body.scheduleMode ?? "RANDOM",
                cycleSeconds: body.cycleSeconds ?? 2700,
                minGapSeconds: body.minGapSeconds ?? 2,
                maxGapSeconds: body.maxGapSeconds ?? 7,
                batchSize: body.batchSize ?? 60,
                batchRestMinSeconds: body.batchRestMinSeconds ?? 30,
                batchRestMaxSeconds: body.batchRestMaxSeconds ?? 60,
                activeFrom: body.activeFrom ?? "00:00",
                activeTo: body.activeTo ?? "23:59",
            },
        });
        return { campaign };
    });
    app.patch("/api/campaigns/:id", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const campaign = await prisma_1.prisma.campaign.update({ where: { id }, data: body });
        if (body.status) {
            await prisma_1.prisma.sendLog.create({
                data: {
                    accountId: campaign.accountId,
                    campaignId: campaign.id,
                    level: "INFO",
                    message: body.status === "ACTIVE"
                        ? `Campaña "${campaign.folderName}" activada desde el panel`
                        : `Campaña "${campaign.folderName}" pausada desde el panel`,
                },
            });
        }
        return { campaign };
    });
    app.delete("/api/campaigns/:id", async (request) => {
        const { id } = request.params;
        await prisma_1.prisma.campaign.delete({ where: { id } });
        return { ok: true };
    });
    // --- Destinos de una campaña ---
    app.post("/api/campaigns/:id/destinations", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const destination = await prisma_1.prisma.campaignDestination.create({
            data: {
                campaignId: id,
                chatId: body.chatId,
                chatTitle: body.chatTitle,
                topicId: body.topicId ?? null,
            },
        });
        return { destination };
    });
    app.delete("/api/destinations/:id", async (request) => {
        const { id } = request.params;
        await prisma_1.prisma.campaignDestination.delete({ where: { id } });
        return { ok: true };
    });
    // "Seleccionar grupos a los que NO enviar": marca/desmarca un destino como
    // excluido sin borrarlo (a diferencia del DELETE de arriba) - randomEngine
    // y fixedEngine lo saltan mientras esté excluded=true. Se puede reactivar
    // en cualquier momento sin tener que volver a leer la carpeta de Telegram.
    app.patch("/api/destinations/:id", async (request) => {
        const { id } = request.params;
        const body = request.body;
        if (typeof body.excluded !== "boolean") {
            return { destination: await prisma_1.prisma.campaignDestination.findUniqueOrThrow({ where: { id } }) };
        }
        const destination = await prisma_1.prisma.campaignDestination.update({ where: { id }, data: { excluded: body.excluded } });
        return { destination };
    });
    // --- Copiar TODAS las campañas de una cuenta a otra ---
    //
    // Cada campaña "pertenece" a un origen (SourceGroup) de SU cuenta, y el
    // origen de una modelo casi nunca es el mismo chat de Telegram que el de
    // otra - así que no se puede simplemente reasignar el sourceGroupId tal
    // cual. En vez de intentar adivinar una correspondencia automática (que
    // podría acabar reenviando desde el sitio equivocado), se pide un único
    // origen YA EXISTENTE en la cuenta destino y se usa para todas las
    // campañas copiadas - es raro que una cuenta tenga más de un origen
    // configurado, y si tiene varios, el admin elige cuál.
    //
    // Lo que SÍ se copia entera y automáticamente por campaña: ajustes de
    // envío/ritmo, horarios fijos (si los tiene) y destinos (mismos chats de
    // Telegram - la carpeta ya no importa una vez creados como destinos
    // sueltos). Las campañas nuevas nacen SIEMPRE en pausa, igual que
    // cualquier campaña creada a mano, para que el admin las revise antes de
    // que se pongan a enviar solas.
    app.post("/api/accounts/:accountId/campaigns/copy-to", async (request, reply) => {
        const { accountId } = request.params;
        const body = request.body;
        const targetAccountId = body.targetAccountId;
        const targetSourceGroupId = body.targetSourceGroupId;
        if (!targetAccountId)
            return reply.code(400).send({ error: "Elige a qué cuenta copiar las campañas." });
        if (targetAccountId === accountId)
            return reply.code(400).send({ error: "Elige una cuenta distinta a la actual." });
        if (!targetSourceGroupId)
            return reply.code(400).send({ error: "Elige el origen de la cuenta destino que usarán las campañas copiadas." });
        // "targetAccountId" viaja en el body, no en la URL - el guardia general
        // de index.ts solo comprueba la agencia de ":accountId" (la cuenta de
        // ORIGEN), así que sin este chequeo cualquier agencia podría copiar sus
        // campañas dentro de una cuenta de OTRA agencia con solo adivinar/
        // reutilizar su id.
        const [sourceAccount, targetAccount] = await Promise.all([
            prisma_1.prisma.account.findUnique({ where: { id: accountId }, select: { agencyId: true } }),
            prisma_1.prisma.account.findUnique({ where: { id: targetAccountId }, select: { agencyId: true } }),
        ]);
        if (!targetAccount || !sourceAccount || targetAccount.agencyId !== sourceAccount.agencyId) {
            return reply.code(400).send({ error: "Esa cuenta destino no existe." });
        }
        const targetSourceGroup = await prisma_1.prisma.sourceGroup.findUnique({ where: { id: targetSourceGroupId } });
        if (!targetSourceGroup || targetSourceGroup.accountId !== targetAccountId) {
            return reply.code(400).send({ error: "Ese origen no pertenece a la cuenta destino." });
        }
        const campaigns = await prisma_1.prisma.campaign.findMany({
            where: { accountId },
            include: { destinationChats: true, scheduleSlots: true },
        });
        if (campaigns.length === 0) {
            return reply.code(400).send({ error: "Esta cuenta no tiene ninguna campaña que copiar." });
        }
        const created = [];
        for (const c of campaigns) {
            const copy = await prisma_1.prisma.campaign.create({
                data: {
                    accountId: targetAccountId,
                    sourceGroupId: targetSourceGroup.id,
                    folderName: c.folderName,
                    status: "PAUSED", // igual que cualquier campaña nueva: nace parada, por seguridad
                    sendMode: c.sendMode,
                    sendAlbums: c.sendAlbums,
                    textOnlyAllowed: c.textOnlyAllowed,
                    scheduleMode: c.scheduleMode,
                    cycleSeconds: c.cycleSeconds,
                    minGapSeconds: c.minGapSeconds,
                    maxGapSeconds: c.maxGapSeconds,
                    batchSize: c.batchSize,
                    batchRestMinSeconds: c.batchRestMinSeconds,
                    batchRestMaxSeconds: c.batchRestMaxSeconds,
                    activeFrom: c.activeFrom,
                    activeTo: c.activeTo,
                    minForeignMessagesBeforeRepeat: c.minForeignMessagesBeforeRepeat,
                },
            });
            if (c.destinationChats.length > 0) {
                await prisma_1.prisma.campaignDestination.createMany({
                    data: c.destinationChats.map((d) => ({
                        campaignId: copy.id,
                        chatId: d.chatId,
                        chatTitle: d.chatTitle,
                        topicId: d.topicId,
                    })),
                    skipDuplicates: true,
                });
            }
            if (c.scheduleSlots.length > 0) {
                await prisma_1.prisma.scheduleSlot.createMany({
                    data: c.scheduleSlots.map((s) => ({
                        campaignId: copy.id,
                        timeOfDay: s.timeOfDay,
                        position: s.position,
                        active: s.active,
                    })),
                    skipDuplicates: true,
                });
            }
            created.push({ id: copy.id, folderName: copy.folderName });
        }
        return { ok: true, count: created.length, campaigns: created };
    });
    // --- Envío manual ---
    // "Enviar ahora" del Reenviador: manda YA (fuera de cualquier horario fijo
    // o aleatorio) el post que ocupa la posición elegida entre los mensajes
    // recientes del origen ya configurado en esta campaña, a los destinos
    // elegidos (o a todos los de la carpeta, si no se elige ninguno en
    // concreto). Reutiliza el mismo motor de envío (sender.ts) que los modos
    // FIXED y RANDOM, así que se comporta igual: mismo modo de envío, mismo
    // control de PeerFlood, y queda registrado en la Consola como cualquier
    // otro envío.
    app.post("/api/campaigns/:id/manual-send", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        const position = Number(body.position);
        if (!position || position < 1) {
            return reply.code(400).send({ error: "Elige una posición válida." });
        }
        const campaign = await prisma_1.prisma.campaign.findUniqueOrThrow({
            where: { id },
            include: { account: true, sourceGroup: true, destinationChats: true },
        });
        if (campaign.destinationChats.length === 0) {
            return reply.code(400).send({ error: `Esta campaña ("${campaign.folderName}") no tiene ningún destino configurado todavía.` });
        }
        // Con destinationIds se manda solo a los destinos elegidos en el panel
        // (checkboxes de "Enviar manual"); sin el campo (llamadas antiguas), se
        // manda a todos los de la carpeta, igual que antes.
        const chosenDestinations = body.destinationIds
            ? campaign.destinationChats.filter((d) => body.destinationIds.includes(d.id))
            : campaign.destinationChats;
        if (chosenDestinations.length === 0) {
            return reply.code(400).send({ error: "Elige al menos un destino." });
        }
        let account;
        try {
            account = await (0, peerFlood_1.ensureAccountReady)(campaign.account);
        }
        catch (err) {
            return reply.code(502).send({ error: err?.message || "No se pudo preparar la cuenta para enviar." });
        }
        if (account.health === "PEER_FLOOD_PAUSED") {
            return reply.code(409).send({ error: "Esta cuenta está pausada por PeerFlood ahora mismo, no se puede enviar." });
        }
        let client;
        try {
            client = await (0, connectionPool_1.getAccountClient)(account);
        }
        catch (err) {
            return reply.code(502).send({ error: err?.message || "No se pudo conectar con Telegram." });
        }
        let group;
        try {
            const messages = await (0, sender_1.getRecentSourceMessages)(client, campaign.sourceGroup);
            group = (0, sender_1.messageAtPosition)(messages, position);
        }
        catch (err) {
            const reason = err?.errorMessage ?? err?.message ?? String(err);
            return reply.code(502).send({ error: reason });
        }
        if (!group) {
            return reply.code(400).send({ error: `No hay ningún mensaje en la posición ${position} del origen ahora mismo.` });
        }
        const results = [];
        let peerFloodPaused = false;
        for (const destination of chosenDestinations) {
            const outcome = await (0, sender_1.deliverMessage)(client, campaign, campaign.sourceGroup, destination, group);
            await (0, sender_1.logSendOutcome)({
                accountId: account.id,
                campaignId: campaign.id,
                chatTitle: destination.chatTitle,
                outcome,
                sourceMessageId: group[0].id,
            });
            results.push({
                chatTitle: destination.chatTitle,
                ok: outcome.ok,
                error: outcome.ok ? undefined : String(outcome.error?.errorMessage ?? outcome.error?.message ?? outcome.error),
            });
            if (!outcome.ok && (0, peerFlood_1.isFloodError)(outcome.error)) {
                await (0, peerFlood_1.handlePeerFlood)(account, outcome.error);
                peerFloodPaused = true;
                break; // igual que en los motores automáticos: corta el resto de destinos, la cuenta queda pausada
            }
        }
        await prisma_1.prisma.sendLog.create({
            data: {
                accountId: account.id,
                campaignId: campaign.id,
                level: "INFO",
                message: `Envío manual: post en posición ${position} mandado a mano desde el panel (${results.filter((r) => r.ok).length}/${chosenDestinations.length} destinos ok).`,
            },
        });
        return { ok: true, results, peerFloodPaused };
    });
}
//# sourceMappingURL=campaigns.js.map