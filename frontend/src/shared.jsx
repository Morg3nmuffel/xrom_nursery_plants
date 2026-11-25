import React from 'react';
import { Sprout } from 'lucide-react';

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <Sprout size={24} strokeWidth={1.85} />
      </span>
      <span>Питомник</span>
    </div>
  );
}
export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch('/api/' + path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Nursery-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !['login', 'employee/login'].includes(path)) location.replace('/');
    throw new Error(data.error?.message || 'Не удалось выполнить запрос.');
  }
  return data;
}
export const stages = {
  sowing: 'Посев',
  rooting: 'Укоренение',
  growing: 'Доращивание',
  ready: 'Готово к продаже',
};
export const statuses = { todo: 'К выполнению', in_progress: 'В работе', done: 'Готово' };
export const careLabels = {
  watering: 'Полив',
  light: 'Освещение',
  soil: 'Почва',
  pruning: 'Обрезка',
  flowering: 'Цветение',
};
export const num = (n) => new Intl.NumberFormat('ru-RU').format(n);
export const dateTime = (s) =>
  s
    ? new Date(s).toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
export function Badge({ value, labels = stages }) {
  return <span className={'badge ' + value}>{labels[value] || value}</span>;
}
export function Empty({ children }) {
  return <p className="empty">{children}</p>;
}
