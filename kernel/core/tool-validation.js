import { normalizeTools } from '../utils/response-utils.js';

export function valueTypeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'boolean') return 'boolean';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function schemaTypes(schema = {}) {
  let type = schema?.type;
  if (type == null && schema && typeof schema === 'object') {
    if (schema.properties || schema.required || schema.additionalProperties !== undefined) type = 'object';
    else if (schema.items) type = 'array';
  }
  if (Array.isArray(type)) return type.filter(t => typeof t === 'string');
  if (typeof type === 'string') return [type];
  return [];
}

function typeMatches(value, type) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return true;
}

function jsonSchemaEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a === 'number' && typeof b === 'number' && a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonSchemaEqual(item, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key, index) => key === bKeys[index] && jsonSchemaEqual(a[key], b[key]));
  }
  return false;
}

export function validateValueAgainstSchema(value, schema = {}, path = 'args', depth = 0) {
  if (schema === true) return [];
  if (schema === false) return [`${path}: value is not allowed by schema`];
  const schemaObj = schema && typeof schema === 'object' ? schema : {};
  if (depth > 8) return [];
  const errors = [];

  if (Array.isArray(schemaObj.allOf)) {
    for (let i = 0; i < schemaObj.allOf.length; i++) {
      errors.push(...validateValueAgainstSchema(value, schemaObj.allOf[i] ?? {}, `${path}.allOf[${i}]`, depth + 1));
    }
  }

  if (Array.isArray(schemaObj.anyOf)) {
    const optionErrors = schemaObj.anyOf.map(sub => validateValueAgainstSchema(value, sub ?? {}, path, depth + 1));
    if (!optionErrors.some(e => e.length === 0)) errors.push(`${path}: value does not satisfy anyOf options`);
  }

  if (Array.isArray(schemaObj.oneOf)) {
    const optionErrors = schemaObj.oneOf.map(sub => validateValueAgainstSchema(value, sub ?? {}, path, depth + 1));
    const okCount = optionErrors.filter(e => e.length === 0).length;
    if (okCount !== 1) errors.push(`${path}: value must satisfy exactly one oneOf option (matched ${okCount})`);
  }

  if ('const' in schemaObj && !jsonSchemaEqual(value, schemaObj.const)) {
    errors.push(`${path}: expected const=${JSON.stringify(schemaObj.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schemaObj.enum) && !schemaObj.enum.some(v => jsonSchemaEqual(v, value))) {
    errors.push(`${path}: expected one of ${JSON.stringify(schemaObj.enum)}, got ${JSON.stringify(value)}`);
  }

  const types = schemaTypes(schemaObj);
  if (types.length && !types.some(type => typeMatches(value, type))) {
    return [`${path}: expected type ${types.length === 1 ? `'${types[0]}'` : JSON.stringify(types)}, got '${valueTypeName(value)}'`];
  }

  if (typeof value === 'number') {
    if (typeof schemaObj.minimum === 'number' && value < schemaObj.minimum) {
      errors.push(`${path}: number smaller than minimum=${schemaObj.minimum}`);
    }
    if (typeof schemaObj.maximum === 'number' && value > schemaObj.maximum) {
      errors.push(`${path}: number larger than maximum=${schemaObj.maximum}`);
    }
    if (typeof schemaObj.exclusiveMinimum === 'number' && value <= schemaObj.exclusiveMinimum) {
      errors.push(`${path}: number must be greater than exclusiveMinimum=${schemaObj.exclusiveMinimum}`);
    }
    if (typeof schemaObj.exclusiveMaximum === 'number' && value >= schemaObj.exclusiveMaximum) {
      errors.push(`${path}: number must be less than exclusiveMaximum=${schemaObj.exclusiveMaximum}`);
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schemaObj.minLength) && value.length < schemaObj.minLength) {
      errors.push(`${path}: string shorter than minLength=${schemaObj.minLength}`);
    }
    if (Number.isInteger(schemaObj.maxLength) && value.length > schemaObj.maxLength) {
      errors.push(`${path}: string longer than maxLength=${schemaObj.maxLength}`);
    }
    if (typeof schemaObj.pattern === 'string') {
      try {
        if (!new RegExp(schemaObj.pattern).test(value)) errors.push(`${path}: string does not match pattern ${JSON.stringify(schemaObj.pattern)}`);
      } catch {
        // Ignore invalid schema patterns, matching Toolify's best-effort behavior.
      }
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schemaObj.properties && typeof schemaObj.properties === 'object' ? schemaObj.properties : {};
    const required = Array.isArray(schemaObj.required) ? schemaObj.required.filter(k => typeof k === 'string') : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}: missing required property '${key}'`);
    }

    const additional = schemaObj.additionalProperties ?? true;
    for (const [key, childValue] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        errors.push(...validateValueAgainstSchema(childValue, props[key] ?? {}, `${path}.${key}`, depth + 1));
      } else if (additional === false) {
        errors.push(`${path}: unexpected property '${key}'`);
      } else if (additional && typeof additional === 'object') {
        errors.push(...validateValueAgainstSchema(childValue, additional, `${path}.${key}`, depth + 1));
      }
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schemaObj.minItems) && value.length < schemaObj.minItems) {
      errors.push(`${path}: array shorter than minItems=${schemaObj.minItems}`);
    }
    if (Number.isInteger(schemaObj.maxItems) && value.length > schemaObj.maxItems) {
      errors.push(`${path}: array longer than maxItems=${schemaObj.maxItems}`);
    }
    if (Object.prototype.hasOwnProperty.call(schemaObj, 'items')) {
      for (let i = 0; i < value.length; i++) {
        errors.push(...validateValueAgainstSchema(value[i], schemaObj.items, `${path}[${i}]`, depth + 1));
      }
    }
  }

  return errors;
}

function forcedToolName(toolChoice) {
  return toolChoice?.function?.name || toolChoice?.name || undefined;
}

export function validateParsedTools(parsedTools = [], tools = [], toolChoice = 'auto') {
  const normalized = normalizeTools(tools);
  const allowed = new Map(normalized.map(tool => [tool.function.name, tool.function.parameters ?? {}]));
  const allowedNames = [...allowed.keys()].sort();
  const forced = forcedToolName(toolChoice);

  for (let i = 0; i < (parsedTools || []).length; i++) {
    const call = parsedTools[i] || {};
    const name = call.name;
    const args = call.args ?? call.args_json;

    if (!name || typeof name !== 'string') return `Tool call #${i + 1}: missing tool name`;
    if (!allowed.has(name)) return `Tool call #${i + 1}: unknown tool '${name}'. Allowed tools: ${JSON.stringify(allowedNames)}`;
    if (forced && name !== forced) return `Tool call #${i + 1}: tool '${name}' violates tool_choice; only '${forced}' is allowed`;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return `Tool call #${i + 1} '${name}': arguments must be a JSON object, got ${valueTypeName(args)}`;
    }

    const errs = validateValueAgainstSchema(args, allowed.get(name) ?? {}, name);
    if (errs.length) {
      const preview = errs.slice(0, 6).join('; ');
      const more = errs.length > 6 ? ` (+${errs.length - 6} more)` : '';
      return `Tool call #${i + 1} '${name}': schema validation failed: ${preview}${more}`;
    }
  }

  return null;
}
