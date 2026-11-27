import React, { useEffect, useId, useRef, useState } from 'react';
import { photoMaxBytes, photoTypes } from '../../backend/catalog/photos.mjs';
import { api, careLabels } from './shared';
import { FormFoot, useSubmit } from './components';

export function EmployeeForm({ saved }) {
  const { submit, busy, error } = useSubmit(async form => {
    await api('tasks/employees', { method: 'POST', body: Object.fromEntries(form) });
    saved('Сотрудник добавлен.');
  });
  return <form className="edit-form" onSubmit={submit}>
    <label>Имя сотрудника<input name="name" maxLength={120} required /></label>
    <label>Логин<input name="username" maxLength={120} autoComplete="off" required /></label>
    <label>Пароль<input name="password" type="password" maxLength={1024} autoComplete="new-password" required /></label>
    <FormFoot {...{ busy, error }} label="Добавить сотрудника" />
  </form>;
}

export function TaskForm({ employees, batches, day, saved }) {
  const { submit, busy, error } = useSubmit(async form => {
    await api('tasks/tasks', { method: 'POST', body: {
      title: form.get('title'), instructions: form.get('instructions'), due_on: form.get('due_on'),
      assignee_id: Number(form.get('assignee_id')) || null, batch_id: Number(form.get('batch_id')) || null,
    } });
    saved('Задача добавлена.');
  });
  return <form className="edit-form" onSubmit={submit}>
    <label>Название задачи<input name="title" maxLength={200} required /></label>
    <label>Что сделать<textarea name="instructions" maxLength={4000} rows={3} /></label>
    <label>Исполнитель<select name="assignee_id">
      <option value="">Назначить автоматически</option>
      {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
    </select></label>
    <label>Партия<select name="batch_id">
      <option value="">Общая задача питомника</option>
      {batches.filter(b => b.quantity > 0).map(b =>
        <option key={b.id} value={b.id}>№{b.id} · {b.name} · {b.location}</option>)}
    </select></label>
    <label>Срок<input name="due_on" type="date" defaultValue={day} required /></label>
    <FormFoot {...{ busy, error }} label="Добавить задачу" />
  </form>;
}

function PriceInput({ value }) {
  return <label>Цена за растение, ₽<input name="price" type="number" min="0" max="9999999999.99"
    step="0.01" defaultValue={value ?? ''} placeholder="Не указана" /></label>;
}

function readPrice(form) {
  const value = form.get('price');
  return value === '' ? null : Number(value);
}

export function PriceForm({ plant, saved }) {
  const { submit, busy, error } = useSubmit(async form => {
    await api('plants/plants/price?id=' + encodeURIComponent(plant.id), {
      method: 'PATCH', body: { price_rub: readPrice(form) },
    });
    saved('Цена сохранена.');
  });
  return <form className="edit-form" onSubmit={submit}>
    <strong>{plant.name}</strong><PriceInput value={plant.price_rub} />
    <FormFoot {...{ busy, error }} label="Сохранить цену" />
  </form>;
}

function checkPhoto(file) {
  if (!photoTypes.includes(file.type)) return 'Выберите фото в формате JPG, PNG или WebP.';
  if (!file.size) return 'Файл фото пуст.';
  if (file.size > photoMaxBytes) return 'Размер фото должен быть не больше 5 МБ.';
  return '';
}

async function encodePhoto(file) {
  if (!file?.name) return undefined;
  const error = checkPhoto(file);
  if (error) throw new Error(error);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Не удалось прочитать фото. Выберите файл ещё раз.'));
    reader.readAsDataURL(file);
  });
}

function CatalogPhotoField({ disabled }) {
  const hint = useId();
  const inputRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(false);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  function choosePhoto(event) {
    const input = event.currentTarget;
    const file = input.files[0];
    const error = file ? checkPhoto(file) : '';
    input.setCustomValidity(error);
    if (error) input.reportValidity();
    setSelected(Boolean(file));
    setPreview(file && !error ? URL.createObjectURL(file) : null);
  }
  function clearPhoto() {
    inputRef.current.value = '';
    inputRef.current.setCustomValidity('');
    inputRef.current.focus();
    setSelected(false);
    setPreview(null);
  }
  function invalidPreview() {
    inputRef.current.setCustomValidity('Не удалось открыть фото. Выберите другой файл.');
    inputRef.current.reportValidity();
    setPreview(null);
  }
  return <div className="catalog-photo-field">
    <label>Фото растения
      <input ref={inputRef} name="photo" type="file" accept={photoTypes.join(',')} aria-describedby={hint}
        disabled={disabled} onChange={choosePhoto} />
    </label>
    <small id={hint}>Необязательно. JPG, PNG или WebP, до 5 МБ.</small>
    {preview && <img key={preview} className="catalog-photo-preview" src={preview} alt="Предпросмотр фото"
      onError={invalidPreview} />}
    {selected && <button type="button" className="text-button" disabled={disabled} onClick={clearPhoto}>Убрать фото</button>}
  </div>;
}

export function CatalogForm({ saved }) {
  const { submit, busy, error } = useSubmit(async form => {
    const care = Object.fromEntries(['scientific_name', 'category', ...Object.keys(careLabels)].map(k => [k, form.get(k)]));
    care.height = { min_cm: Number(form.get('min_cm')), max_cm: Number(form.get('max_cm')) };
    care.hardiness = { zone: form.get('zone'), min_temperature_c: Number(form.get('temperature')), notes: form.get('notes') };
    const photo = await encodePhoto(form.get('photo'));
    await api('plants/plants', { method: 'POST', body: {
      id: form.get('id'), name: form.get('name'), price_rub: readPrice(form), care, photo,
    } });
    saved('Карточка растения сохранена.');
  });
  return <form className="edit-form" onSubmit={submit}>
    <label>Название растения<input name="name" maxLength={160} required /></label>
    <label>Артикул<input name="id" maxLength={160} required /></label>
    <CatalogPhotoField disabled={busy} />
    <PriceInput />
    <label>Научное название<input name="scientific_name" required /></label>
    <label>Категория<input name="category" required /></label>
    {Object.entries(careLabels).map(([key, label]) => <label key={key}>{label}<textarea name={key} rows={2} maxLength={4000} required /></label>)}
    <div className="form-pair">
      <label>Мин. высота, см<input name="min_cm" type="number" min="0" step="any" required /></label>
      <label>Макс. высота, см<input name="max_cm" type="number" min="0" step="any" required /></label>
    </div>
    <div className="form-pair">
      <label>Зона зимостойкости<input name="zone" required /></label>
      <label>Мин. температура, °C<input name="temperature" type="number" step="any" required /></label>
    </div>
    <label>Условия зимовки<textarea name="notes" rows={2} maxLength={4000} /></label>
    <FormFoot {...{ busy, error }} label="Добавить растение" />
  </form>;
}

export function RemoveForm({ target, saved, cancel }) {
  const { submit, busy, error } = useSubmit(async () => {
    await api(target.path, { method: 'DELETE' });
    saved('Запись удалена.');
  });
  return <form className="edit-form" onSubmit={submit}>
    <strong>{target.name}</strong><p>{target.effect}</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="form-foot">
      <button type="button" className="btn" onClick={cancel} disabled={busy}>Отмена</button>
      <button className="btn danger" disabled={busy}>{busy ? 'Удаление…' : 'Удалить'}</button>
    </div>
  </form>;
}
