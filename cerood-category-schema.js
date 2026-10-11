'use strict';
const bool = value => value === true || String(value).toLowerCase() === 'true';
function embeddedRows(category, kind) {
  let fields = category[kind === 'attribute' ? 'attribute_schema' : 'image_schema'];
  if (typeof fields === 'string') { try { fields = JSON.parse(fields); } catch (_) { fields = []; } }
  if (!Array.isArray(fields)) return [];
  return fields.filter(f => f && typeof f === 'object' && !Array.isArray(f)).flatMap((f, index) => {
    const key = String(kind === 'attribute' ? (f.attribute_key ?? f.key ?? '') : (f.slot_key ?? f.key ?? '')).trim();
    if (!/^[a-z0-9_]{1,80}$/i.test(key) || f.is_active === false) return [];
    const row = {category_id: category.id, label: String(f.label || key), is_required: bool(f.is_required ?? f.required), sort_order: Number(f.sort_order) || index};
    if (kind === 'attribute') {
      Object.assign(row, {attribute_key:key, input_type:String(f.input_type ?? f.type ?? 'text').toLowerCase(),
        is_variant:bool(f.is_variant ?? f.variant), options:Array.isArray(f.options) ? f.options : [],
        unit:String(f.unit || ''), placeholder:String(f.placeholder || '')});
    } else Object.assign(row, {slot_key:key, description:String(f.description ?? f.instruction ?? '')});
    return [row];
  });
}
// Parent first, then child. Normalized definitions win over embedded definitions
// at the same category; a child's definition wins over its parent's definition.
function resolveFields(chain, normalized, kind) {
  const keyName = kind === 'attribute' ? 'attribute_key' : 'slot_key';
  const merged = new Map();
  for (const category of [...chain].reverse()) {
    for (const row of embeddedRows(category, kind)) merged.set(row[keyName], row);
    for (const row of normalized.filter(r => String(r.category_id) === String(category.id))) merged.set(String(row[keyName]), row);
  }
  return [...merged.values()].sort((a,b) => Number(a.sort_order || 0)-Number(b.sort_order || 0) || String(a.label || '').localeCompare(String(b.label || '')));
}
module.exports = {resolveFields};
