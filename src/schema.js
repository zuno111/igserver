// 데이터 스키마 검증. 컬렉션별 필드 규칙으로 쓰기 데이터를 검증한다.
// 스키마는 프로젝트 settings.schemas[collection] = { fields: { name: {type, required, min, max, enum} }, strict }
// type: string | number | boolean | array | object

const TYPECHECK = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && !isNaN(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v && typeof v === 'object' && !Array.isArray(v),
};

export function validate(schema, data) {
  const errors = [];
  const fields = schema.fields || {};
  data = data || {};

  for (const [name, rule] of Object.entries(fields)) {
    const v = data[name];
    if (v === undefined || v === null) {
      if (rule.required) errors.push(`${name}: 필수 항목입니다`);
      continue;
    }
    if (rule.type && TYPECHECK[rule.type] && !TYPECHECK[rule.type](v)) {
      errors.push(`${name}: ${rule.type} 타입이어야 합니다`);
      continue;
    }
    if (rule.enum && Array.isArray(rule.enum) && !rule.enum.includes(v)) {
      errors.push(`${name}: ${rule.enum.join(', ')} 중 하나여야 합니다`);
    }
    if (rule.type === 'number') {
      if (typeof rule.min === 'number' && v < rule.min) errors.push(`${name}: ${rule.min} 이상이어야 합니다`);
      if (typeof rule.max === 'number' && v > rule.max) errors.push(`${name}: ${rule.max} 이하여야 합니다`);
    }
    if (rule.type === 'string') {
      if (typeof rule.min === 'number' && v.length < rule.min) errors.push(`${name}: ${rule.min}자 이상이어야 합니다`);
      if (typeof rule.max === 'number' && v.length > rule.max) errors.push(`${name}: ${rule.max}자 이하여야 합니다`);
      if (rule.pattern) { try { if (!new RegExp(rule.pattern).test(v)) errors.push(`${name}: 형식이 올바르지 않습니다`); } catch {} }
    }
  }

  // strict 모드: 스키마에 없는 필드 거부
  if (schema.strict) {
    for (const key of Object.keys(data)) {
      if (!fields[key]) errors.push(`${key}: 허용되지 않은 필드입니다`);
    }
  }
  return errors;
}

// 프로젝트에서 컬렉션 스키마 가져오기
export function getSchema(project, collection) {
  return project?.settings?.schemas?.[collection] || null;
}
