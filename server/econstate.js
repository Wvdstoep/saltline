// The active world economy (server/worldecon.js) seen from server/economy.js without an import cycle. One game per
// process in production; tests that build several games get the most recent one (prices are deterministic per dataset).
let active = null;
export function setActiveEcon(e) { active = e || null; }
export function activeEcon() { return active; }
