import { prisma } from "../utils/prisma";
import {
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  SignalDataTypeMap,
} from "@whiskeysockets/baileys";

/**
 * Adaptador de "multi file auth state" de Baileys pero contra la BD en vez
 * de contra archivos: Railway no tiene disco persistente entre despliegues
 * (ver Dockerfile), así que si esto se guardara en un archivo normal habría
 * que volver a escanear el QR cada vez que se hace "railway up". Cada
 * "clave" que pide guardar Baileys (creds del dispositivo, sesiones de
 * Signal, pre-keys...) se guarda como una fila en WhatsAppAuthKey, igual
 * que el adaptador oficial useMultiFileAuthState pero fila = archivo.
 */

async function readKey(id: string): Promise<any | null> {
  const row = await prisma.whatsAppAuthKey.findUnique({ where: { id } });
  if (!row) return null;
  try {
    return JSON.parse(row.data, BufferJSON.reviver);
  } catch {
    return null;
  }
}

async function writeKey(id: string, data: any): Promise<void> {
  const serialized = JSON.stringify(data, BufferJSON.replacer);
  await prisma.whatsAppAuthKey.upsert({
    where: { id },
    update: { data: serialized },
    create: { id, data: serialized },
  });
}

async function removeKey(id: string): Promise<void> {
  await prisma.whatsAppAuthKey.delete({ where: { id } }).catch(() => {});
}

export async function useDbAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const existingCreds = await readKey("creds");
  const creds = existingCreds || initAuthCreds();

  // "as any" en las claves: Baileys tipa keys.get como un método genérico
  // (<T extends keyof SignalDataTypeMap>...), y TypeScript no deja asignar
  // una implementación concreta (no genérica) a esa forma sin quejarse -
  // igual de estricto que lo que rompió el build la última vez. Como aquí
  // no hay forma de probar "tsc" antes de subir a Railway, mejor evitar
  // ese tipo de comprobación en vez de arriesgarse a adivinar mal.
  const keys: any = {
    get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
      const data: { [id: string]: any } = {};
      await Promise.all(
        ids.map(async (id) => {
          let value = await readKey(`${type}-${id}`);
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          data[id] = value;
        })
      );
      return data;
    },
    set: async (data: any) => {
      const tasks: Promise<void>[] = [];
      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id];
          const key = `${category}-${id}`;
          tasks.push(value ? writeKey(key, value) : removeKey(key));
        }
      }
      await Promise.all(tasks);
    },
  };

  return {
    state: { creds, keys } as AuthenticationState,
    saveCreds: () => writeKey("creds", creds),
  };
}

/** Borra toda la sesión guardada (todas las filas de WhatsAppAuthKey), para
 * "Desconectar" o cuando Telegram... digo, WhatsApp cierra la sesión sola
 * (dispositivo desvinculado desde el móvil) y hay que empezar de cero con
 * un QR nuevo. */
export async function clearDbAuthState(): Promise<void> {
  await prisma.whatsAppAuthKey.deleteMany({});
}
