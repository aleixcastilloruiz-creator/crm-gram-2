import { Account, FanSale } from "@prisma/client";
import { prisma } from "../utils/prisma";
import { sendWhatsAppMessage, sendWhatsAppToDestinations } from "./waClient";

/** Configuración de "Conectar WhatsApp" (fila única). Se crea sola con los
 * valores por defecto la primera vez que se pide. */
async function getSettings() {
  const row = await prisma.whatsAppSettings.findUnique({ where: { id: "singleton" } });
  if (row) return row;
  return prisma.whatsAppSettings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
}

/** Aviso del Detector de pagos: a toda la lista de "A quién avisar". Nunca
 * lanza - un fallo de WhatsApp no debe tumbar el puente en vivo. */
export async function notifyPaymentDetection(text: string): Promise<void> {
  try {
    const settings = await getSettings();
    await sendWhatsAppToDestinations(settings.paymentDestinations, text);
  } catch (err) {
    console.error("[whatsapp] error avisando del detector de pagos:", err);
  }
}

/** Aviso de bloqueo de Telegram (PeerFlood/FLOOD_WAIT del reenviador): a la
 * misma lista de "A quién avisar" que el Detector de pagos - así lo anuncia
 * ya el propio panel de "Conectar WhatsApp" ("los pagos sospechosos y los
 * bloqueos de Telegram siguen yendo solo a «A quién avisar»"), aunque el
 * motor de envíos todavía no lo hacía de verdad (ver peerFlood.ts). Nunca
 * lanza - un fallo de WhatsApp no debe tumbar el reenviador. */
export async function notifyTelegramBlock(text: string): Promise<void> {
  try {
    const settings = await getSettings();
    await sendWhatsAppToDestinations(settings.paymentDestinations, text);
  } catch (err) {
    console.error("[whatsapp] error avisando del bloqueo de Telegram:", err);
  }
}

function fmtMoney(amount: number): string {
  return amount.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "€";
}

/** "Grupos de seguimiento de las modelos": al registrar una venta (pestaña
 * Mensajes → registrar venta), avisa con "el mensaje de siempre" al grupo
 * de todos los trabajadores y al grupo de seguimiento propio de la modelo,
 * cada uno con sus propias casillas de "qué más lleva el mensaje" (precio /
 * quién la vendió). Si el interruptor general está apagado, o no hay
 * ningún grupo elegido, no hace nada. Solo avisa de ventas de un SERVICIO
 * PERSONALIZADO (no de todas las ventas) - las demás se siguen guardando y
 * viendo igual en Informes, simplemente no generan aviso por WhatsApp.
 * Nunca lanza. */
export async function notifySaleToGroups(account: Account, sale: FanSale): Promise<void> {
  try {
    if (!sale.service || !/personalizad/i.test(sale.service)) return;

    const settings = await getSettings();
    if (!settings.notifySalesToGroups) return;

    const baseLine = `💰 Venta registrada · ${account.label}${sale.service ? " — " + sale.service : ""}`;

    const buildMessage = (includePrice: boolean, includeSoldBy: boolean) => {
      const lines = [baseLine];
      if (includePrice) lines.push(`Precio: ${fmtMoney(sale.amount)}`);
      if (includeSoldBy && sale.soldBy) lines.push(`Vendido por: ${sale.soldBy}`);
      return lines.join("\n");
    };

    const tasks: Promise<void>[] = [];
    if (settings.allWorkersGroupId) {
      const text = buildMessage(settings.allGroupIncludePrice, settings.allGroupIncludeSoldBy);
      tasks.push(
        sendWhatsAppMessage(settings.allWorkersGroupId, text).catch((err) =>
          console.error("[whatsapp] no se pudo avisar al grupo de todos los trabajadores:", err)
        )
      );
    }
    if (account.salesTrackingWhatsAppGroupId) {
      const text = buildMessage(settings.modelGroupIncludePrice, settings.modelGroupIncludeSoldBy);
      tasks.push(
        sendWhatsAppMessage(account.salesTrackingWhatsAppGroupId, text).catch((err) =>
          console.error(`[whatsapp] no se pudo avisar al grupo de seguimiento de "${account.label}":`, err)
        )
      );
    }
    await Promise.all(tasks);
  } catch (err) {
    console.error("[whatsapp] error avisando de la venta:", err);
  }
}
