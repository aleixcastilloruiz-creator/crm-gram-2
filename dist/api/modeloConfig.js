"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerModeloConfigRoutes = registerModeloConfigRoutes;
const prisma_1 = require("../utils/prisma");
const phoneCountry_1 = require("../telegram/phoneCountry");
/**
 * Resto de Configuración → Modelos → esta creadora, aparte de lo que ya vive
 * en messages.ts (Notas/nota general) y freeChannels.ts (Precios/Canales
 * free): Respuestas rápidas, Bloqueo automático por país, Carpetas de
 * Telegram (sincronizar/excluir), Grupos restringidos (cuenta ayudante),
 * "Colorear por carpeta" y los paquetes SFS.
 *
 * Las rutas de aquí guardan las preferencias. El comportamiento en vivo que
 * depende de ellas vive en otros sitios: el bloqueo por país en
 * telegram/liveEvents.ts (al llegar un mensaje), la sincronización de
 * carpetas en el PUT de la nota del fan de messages.ts, y la cuenta
 * ayudante de grupos restringidos en el POST de restricted-group de
 * messages.ts (telegram/folders.ts tiene el añadir-a-carpeta).
 */
async function registerModeloConfigRoutes(app) {
    // --- Respuestas rápidas ---
    app.get("/api/accounts/:id/quick-replies", async (request) => {
        const { id } = request.params;
        const replies = await prisma_1.prisma.quickReply.findMany({ where: { accountId: id }, orderBy: { createdAt: "asc" } });
        return { replies };
    });
    app.post("/api/accounts/:id/quick-replies", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        const text = (body.text || "").trim();
        if (!text)
            return reply.code(400).send({ error: "Escribe el texto de la respuesta." });
        const created = await prisma_1.prisma.quickReply.create({ data: { accountId: id, text } });
        return { reply: created };
    });
    app.delete("/api/quick-replies/:replyId", async (request) => {
        const { replyId } = request.params;
        await prisma_1.prisma.quickReply.delete({ where: { id: replyId } }).catch(() => { });
        return { ok: true };
    });
    // --- Bloqueo automático por país ---
    app.get("/api/accounts/:id/blocked-countries", async (request) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        let prefixes = [];
        try {
            prefixes = JSON.parse(account.blockedCountries || "[]");
        }
        catch {
            prefixes = [];
        }
        return { prefixes, countries: (0, phoneCountry_1.listKnownCountries)() };
    });
    app.put("/api/accounts/:id/blocked-countries", async (request) => {
        const { id } = request.params;
        const { prefixes } = request.body;
        await prisma_1.prisma.account.update({ where: { id }, data: { blockedCountries: JSON.stringify(prefixes || []) } });
        return { ok: true };
    });
    // --- Excluir carpeta de Telegram (de la lista de Mensajes) ---
    app.get("/api/accounts/:id/excluded-folders", async (request) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        let folders = [];
        try {
            folders = JSON.parse(account.excludedMessageFolders || "[]");
        }
        catch {
            folders = [];
        }
        return { folders };
    });
    app.put("/api/accounts/:id/excluded-folders", async (request) => {
        const { id } = request.params;
        const { folders } = request.body;
        await prisma_1.prisma.account.update({ where: { id }, data: { excludedMessageFolders: JSON.stringify(folders || []) } });
        return { ok: true };
    });
    // --- Carpetas de Telegram: sincronizar automáticamente ---
    app.get("/api/accounts/:id/folder-sync", async (request) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        let map = {};
        try {
            map = JSON.parse(account.folderSyncMap || "{}");
        }
        catch {
            map = {};
        }
        return { enabled: account.autoSyncFoldersEnabled, map };
    });
    app.put("/api/accounts/:id/folder-sync", async (request) => {
        const { id } = request.params;
        const { enabled, map } = request.body;
        await prisma_1.prisma.account.update({
            where: { id },
            data: {
                autoSyncFoldersEnabled: !!enabled,
                folderSyncMap: JSON.stringify(map || {}),
            },
        });
        return { ok: true };
    });
    // --- Grupos restringidos: cuenta ayudante ---
    app.get("/api/accounts/:id/restricted-group-helper", async (request) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        return { helperAccountId: account.restrictedGroupHelperAccountId };
    });
    app.put("/api/accounts/:id/restricted-group-helper", async (request) => {
        const { id } = request.params;
        const { helperAccountId } = request.body;
        await prisma_1.prisma.account.update({ where: { id }, data: { restrictedGroupHelperAccountId: helperAccountId || null } });
        return { ok: true };
    });
    // --- Colorear por carpeta en "Todos los medios" ---
    app.put("/api/accounts/:id/content-color-by-folder", async (request) => {
        const { id } = request.params;
        const { enabled } = request.body;
        await prisma_1.prisma.account.update({ where: { id }, data: { contentColorByFolder: !!enabled } });
        return { ok: true };
    });
    // --- Paquetes SFS ---
    app.get("/api/accounts/:id/sfs-packages", async (request) => {
        const { id } = request.params;
        const packages = await prisma_1.prisma.sfsPackage.findMany({ where: { accountId: id }, orderBy: { createdAt: "asc" } });
        return {
            packages: packages.map((p) => ({
                id: p.id,
                name: p.name,
                captionText: p.captionText,
                media: JSON.parse(p.mediaRefs || "[]"),
            })),
        };
    });
    app.post("/api/accounts/:id/sfs-packages", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        const name = (body.name || "").trim();
        if (!name)
            return reply.code(400).send({ error: "Ponle un nombre al paquete." });
        const media = Array.isArray(body.media) ? body.media.slice(0, 10) : [];
        const created = await prisma_1.prisma.sfsPackage.create({
            data: { accountId: id, name, captionText: body.captionText || "", mediaRefs: JSON.stringify(media) },
        });
        return { package: { id: created.id, name: created.name, captionText: created.captionText, media } };
    });
    app.delete("/api/sfs-packages/:packageId", async (request) => {
        const { packageId } = request.params;
        await prisma_1.prisma.sfsPackage.delete({ where: { id: packageId } }).catch(() => { });
        return { ok: true };
    });
}
//# sourceMappingURL=modeloConfig.js.map