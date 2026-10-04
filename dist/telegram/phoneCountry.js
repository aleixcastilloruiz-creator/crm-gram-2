"use strict";
/**
 * Detector de pais a partir del numero de telefono (prefijo internacional),
 * igual que el "🇪🇸 España" que se ve junto al numero en el panel de
 * referencia. No usa ninguna libreria externa: es una tabla de prefijos de
 * marcado -> pais, ordenada de mas especifica a mas general para que un
 * prefijo de 3 digitos no lo capture antes uno de 1 digito compartido
 * (Norteamerica: +1) por error.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.listKnownCountries = listKnownCountries;
exports.countryFromPhone = countryFromPhone;
exports.prefixFromPhone = prefixFromPhone;
// [prefijo sin "+", nombre, bandera]. Cubre los paises mas habituales para
// una agencia OF (España/LatAm/UE/US/UK...); si no aparece, se muestra solo
// el numero sin bandera en vez de fallar.
const PREFIXES = [
    ["1", "Estados Unidos / Canadá", "🇺🇸"],
    ["7", "Rusia / Kazajistán", "🇷🇺"],
    ["20", "Egipto", "🇪🇬"],
    ["27", "Sudáfrica", "🇿🇦"],
    ["30", "Grecia", "🇬🇷"],
    ["31", "Países Bajos", "🇳🇱"],
    ["32", "Bélgica", "🇧🇪"],
    ["33", "Francia", "🇫🇷"],
    ["34", "España", "🇪🇸"],
    ["351", "Portugal", "🇵🇹"],
    ["352", "Luxemburgo", "🇱🇺"],
    ["353", "Irlanda", "🇮🇪"],
    ["354", "Islandia", "🇮🇸"],
    ["355", "Albania", "🇦🇱"],
    ["356", "Malta", "🇲🇹"],
    ["357", "Chipre", "🇨🇾"],
    ["358", "Finlandia", "🇫🇮"],
    ["359", "Bulgaria", "🇧🇬"],
    ["36", "Hungría", "🇭🇺"],
    ["370", "Lituania", "🇱🇹"],
    ["371", "Letonia", "🇱🇻"],
    ["372", "Estonia", "🇪🇪"],
    ["373", "Moldavia", "🇲🇩"],
    ["374", "Armenia", "🇦🇲"],
    ["375", "Bielorrusia", "🇧🇾"],
    ["376", "Andorra", "🇦🇩"],
    ["377", "Mónaco", "🇲🇨"],
    ["380", "Ucrania", "🇺🇦"],
    ["381", "Serbia", "🇷🇸"],
    ["385", "Croacia", "🇭🇷"],
    ["386", "Eslovenia", "🇸🇮"],
    ["39", "Italia", "🇮🇹"],
    ["40", "Rumanía", "🇷🇴"],
    ["41", "Suiza", "🇨🇭"],
    ["420", "Chequia", "🇨🇿"],
    ["421", "Eslovaquia", "🇸🇰"],
    ["43", "Austria", "🇦🇹"],
    ["44", "Reino Unido", "🇬🇧"],
    ["45", "Dinamarca", "🇩🇰"],
    ["46", "Suecia", "🇸🇪"],
    ["47", "Noruega", "🇳🇴"],
    ["48", "Polonia", "🇵🇱"],
    ["49", "Alemania", "🇩🇪"],
    ["51", "Perú", "🇵🇪"],
    ["52", "México", "🇲🇽"],
    ["53", "Cuba", "🇨🇺"],
    ["54", "Argentina", "🇦🇷"],
    ["55", "Brasil", "🇧🇷"],
    ["56", "Chile", "🇨🇱"],
    ["57", "Colombia", "🇨🇴"],
    ["58", "Venezuela", "🇻🇪"],
    ["593", "Ecuador", "🇪🇨"],
    ["502", "Guatemala", "🇬🇹"],
    ["503", "El Salvador", "🇸🇻"],
    ["504", "Honduras", "🇭🇳"],
    ["505", "Nicaragua", "🇳🇮"],
    ["506", "Costa Rica", "🇨🇷"],
    ["507", "Panamá", "🇵🇦"],
    ["598", "Uruguay", "🇺🇾"],
    ["595", "Paraguay", "🇵🇾"],
    ["591", "Bolivia", "🇧🇴"],
    ["1809", "República Dominicana", "🇩🇴"],
    ["1829", "República Dominicana", "🇩🇴"],
    ["1849", "República Dominicana", "🇩🇴"],
    ["1787", "Puerto Rico", "🇵🇷"],
    ["60", "Malasia", "🇲🇾"],
    ["61", "Australia", "🇦🇺"],
    ["62", "Indonesia", "🇮🇩"],
    ["63", "Filipinas", "🇵🇭"],
    ["64", "Nueva Zelanda", "🇳🇿"],
    ["65", "Singapur", "🇸🇬"],
    ["66", "Tailandia", "🇹🇭"],
    ["81", "Japón", "🇯🇵"],
    ["82", "Corea del Sur", "🇰🇷"],
    ["84", "Vietnam", "🇻🇳"],
    ["86", "China", "🇨🇳"],
    ["90", "Turquía", "🇹🇷"],
    ["91", "India", "🇮🇳"],
    ["92", "Pakistán", "🇵🇰"],
    ["94", "Sri Lanka", "🇱🇰"],
    ["95", "Myanmar", "🇲🇲"],
    ["971", "Emiratos Árabes Unidos", "🇦🇪"],
    ["966", "Arabia Saudí", "🇸🇦"],
    ["972", "Israel", "🇮🇱"],
    ["973", "Baréin", "🇧🇭"],
    ["974", "Catar", "🇶🇦"],
    ["212", "Marruecos", "🇲🇦"],
    ["213", "Argelia", "🇩🇿"],
    ["216", "Túnez", "🇹🇳"],
    ["234", "Nigeria", "🇳🇬"],
    ["254", "Kenia", "🇰🇪"],
];
// Ordenamos por longitud de prefijo descendente para probar primero los mas
// especificos (ej. "351" antes que "35").
const SORTED = [...PREFIXES].sort((a, b) => b[0].length - a[0].length);
/** Lista de países conocidos (prefijo + nombre + bandera), para el
 * desplegable de "Bloqueo automático por país". El prefijo es el
 * identificador que se guarda en Account.blockedCountries. */
function listKnownCountries() {
    return PREFIXES.map(([prefix, name, flag]) => ({ prefix, name, flag })).sort((a, b) => a.name.localeCompare(b.name, "es"));
}
function countryFromPhone(phone) {
    if (!phone)
        return null;
    const digits = phone.replace(/[^\d]/g, "");
    if (!digits)
        return null;
    for (const [prefix, name, flag] of SORTED) {
        if (digits.startsWith(prefix)) {
            return { name, flag };
        }
    }
    return null;
}
/** Igual que countryFromPhone, pero devuelve el prefijo (el identificador
 * que se guarda en Account.blockedCountries) en vez del nombre/bandera. */
function prefixFromPhone(phone) {
    if (!phone)
        return null;
    const digits = phone.replace(/[^\d]/g, "");
    if (!digits)
        return null;
    for (const [prefix] of SORTED) {
        if (digits.startsWith(prefix))
            return prefix;
    }
    return null;
}
//# sourceMappingURL=phoneCountry.js.map