export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function invalid(message) {
  throw new ApiError(400, 'invalid_request', message);
}

export function object(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`Поле ${field} должно быть объектом.`);
  }
  return value;
}

export function string(value, field, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    invalid(`Поле ${field} должно содержать от 1 до ${max} символов.`);
  }
  return value.trim();
}

export function quantity(value, min = 0) {
  if (!Number.isInteger(value) || value < min || value > 2147483647) {
    invalid(`Количество должно быть целым числом от ${min} до 2147483647.`);
  }
  return value;
}

export function utcDate(value, field = 'due_at') {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) {
    invalid(`Дата ${field} должна быть в формате UTC, например 2027-04-10T08:00:00Z.`);
  }
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  const date = new Date(canonical);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) {
    invalid(`Некорректная дата ${field}.`);
  }
  return canonical;
}
