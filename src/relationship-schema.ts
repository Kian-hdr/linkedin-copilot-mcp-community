export const relationshipSchema = [
  "CREATE TABLE IF NOT EXISTS copilot_annotations(owner TEXT NOT NULL,thread_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(owner,thread_id))",
  "CREATE TABLE IF NOT EXISTS copilot_entities(owner TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,source_thread TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(owner,kind,id))",
  "CREATE INDEX IF NOT EXISTS copilot_entities_thread ON copilot_entities(owner,source_thread,kind)",
  "CREATE TABLE IF NOT EXISTS copilot_entity_guard(owner TEXT PRIMARY KEY,revision INTEGER NOT NULL)",
  `CREATE TRIGGER IF NOT EXISTS copilot_organization_delete AFTER DELETE ON copilot_entities WHEN OLD.kind='organization' BEGIN UPDATE copilot_threads SET revision=revision+1 WHERE owner=OLD.owner AND id IN (SELECT source_thread FROM copilot_entities WHERE owner=OLD.owner AND kind='opportunity' AND json_extract(value,'$.organizationId')=OLD.id); UPDATE copilot_entities SET revision=revision+1,value=json_remove(value,'$.organizationId') WHERE owner=OLD.owner AND kind='opportunity' AND json_extract(value,'$.organizationId')=OLD.id; END`,
  "CREATE TRIGGER IF NOT EXISTS copilot_relationship_delete AFTER DELETE ON copilot_threads BEGIN DELETE FROM copilot_annotations WHERE owner=OLD.owner AND thread_id=OLD.id; DELETE FROM copilot_entities WHERE owner=OLD.owner AND source_thread=OLD.id; END",
];
