export const roleLabels = { admin: 'Администратор', employee: 'Сотрудник', customer: 'Покупатель' };

export function roleFromPath(pathname) {
  const first = pathname.split('/')[1];
  return Object.hasOwn(roleLabels, first) ? first : null;
}

export const roleHome = (role) => (role ? '/' + role + '/' : '/');
