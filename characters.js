// Récupération et mise en cache des personnages depuis l'API publique de gi.yatta.moe.
// La liste est rafraîchie périodiquement : les nouveaux personnages apparaissent tout seuls.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_URL = 'https://gi.yatta.moe/api/v2/fr/avatar';
const ASSET_URL = 'https://gi.yatta.moe/assets/UI/';
const REFRESH_MS = 6 * 60 * 60 * 1000;

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const IMG_DIR = path.join(DATA_DIR, 'img');
const CACHE_FILE = path.join(DATA_DIR, 'characters.json');

const ELEMENTS = {
  Fire: 'Pyro', Water: 'Hydro', Wind: 'Anémo', Electric: 'Électro',
  Grass: 'Dendro', Ice: 'Cryo', Rock: 'Géo',
};
// Comparaison par préfixe : les variantes inconnues (ex. NODKRAI_XXX) retombent sur la bonne région.
const REGIONS = [
  ['MONDSTADT', 'Mondstadt'], ['LIYUE', 'Liyue'], ['INAZUMA', 'Inazuma'],
  ['SUMERU', 'Sumeru'], ['FONTAINE', 'Fontaine'], ['NATLAN', 'Natlan'],
  ['NODKRAI', 'Nod-Krai'], ['SNEZHNAYA', 'Snezhnaya'], ['FATUI', 'Snezhnaya'],
  ['MAINACTOR', 'Hors Teyvat'], ['RANGER', 'Hors Teyvat'],
];
const TRAVELER_ICONS = new Set(['UI_AvatarIcon_PlayerBoy', 'UI_AvatarIcon_PlayerGirl']);

let all = []; // tous les personnages connus, y compris ceux pas encore sortis
let updatedAt = 0;

function normalize(data) {
  const byIcon = new Map();
  const list = [];
  for (const raw of Object.values(data.items ?? {})) {
    if (!raw?.name || !/^UI_AvatarIcon_\w+$/.test(raw.icon ?? '')) continue;
    if (raw.icon.includes('Mannequin')) continue; // avatars personnalisables, pas de vrais personnages
    const release = (raw.release ?? 0) * 1000;
    const seen = byIcon.get(raw.icon);
    if (seen) {
      // Le Voyageur existe en une version par élément : on garde une seule carte, à sa date la plus ancienne.
      seen.release = Math.min(seen.release, release);
      continue;
    }
    const traveler = TRAVELER_ICONS.has(raw.icon);
    const body = raw.bodyType ?? '';
    const char = {
      id: String(raw.id).split('-')[0],
      name: raw.name,
      icon: raw.icon,
      rank: raw.rank === 5 ? 5 : 4,
      element: traveler ? 'Tous' : ELEMENTS[raw.element] ?? 'Aucun',
      weapon: data.types?.[raw.weaponType] ?? 'Inconnue',
      region: REGIONS.find(([key]) => String(raw.region).startsWith(key))?.[1] ?? 'Autre',
      gender: body === 'BOY' || body === 'MALE' ? 'Masculin' : 'Féminin',
      height: body === 'LOLI' ? 'Petit' : body === 'LADY' || body === 'MALE' ? 'Grand' : 'Moyen',
      release,
    };
    byIcon.set(raw.icon, char);
    list.push(char);
  }
  return list;
}

async function refresh() {
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = normalize((await res.json()).data ?? {});
    if (list.length < 10) throw new Error('réponse inattendue');
    all = list;
    updatedAt = Date.now();
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify({ updatedAt, all }));
    console.log(`[personnages] ${all.length} personnages à jour`);
  } catch (err) {
    console.warn(`[personnages] mise à jour impossible : ${err.message}`);
  }
}

export async function initCharacters() {
  try {
    ({ all, updatedAt } = JSON.parse(await readFile(CACHE_FILE, 'utf8')));
  } catch { /* pas encore de cache */ }
  await refresh();
  setInterval(refresh, REFRESH_MS).unref();
}

/** Personnages déjà sortis (la date de sortie est vérifiée à chaque appel). */
export function getCharacters() {
  const now = Date.now();
  return all.filter((c) => c.release <= now);
}

export function getUpdatedAt() {
  return updatedAt;
}

/** Image d'un personnage, téléchargée une fois puis servie depuis le disque. */
export async function getImage(icon) {
  if (!/^UI_AvatarIcon_\w+$/.test(icon) || !all.some((c) => c.icon === icon)) return null;
  const file = path.join(IMG_DIR, `${icon}.png`);
  try {
    return await readFile(file);
  } catch { /* pas encore en cache */ }
  const res = await fetch(`${ASSET_URL}${icon}.png`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(IMG_DIR, { recursive: true });
  await writeFile(file, buf);
  return buf;
}
