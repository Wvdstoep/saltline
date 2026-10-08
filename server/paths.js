// Data directory (generated / cached data). Its own module so osm.js does not import world.js (world.js → bigports.js
// → osm.js would otherwise be an import cycle).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.SALTLINE_DATA || path.join(__dirname, '..', 'data');
