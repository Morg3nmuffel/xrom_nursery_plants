import React, { useEffect, useId, useRef, useState } from 'react';
import { X, Search, Leaf, Trees, Flower2, MapPin, ChevronRight } from 'lucide-react';
import { Badge, Empty, num } from './shared';

export function Modal({ title, close, children }) {
  const ref = useRef(null),
    id = useId();
  useEffect(() => {
    const el = ref.current;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="modal-shell">
        <div className="modal-head">
          <h2 id={id}>{title}</h2>
          <button className="iconbtn" aria-label="Закрыть" onClick={close}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function PanelHead({ title, action, onAction, icon: Icon }) {
  return (
    <div className="panel-head">
      <h2>
        {Icon && <Icon size={19} />} {title}
      </h2>
      {action && (
        <button className="text-button" onClick={onAction}>
          {action}
          <ChevronRight size={15} />
        </button>
      )}
    </div>
  );
}
export function PlantIcon({ id }) {
  const conifer = /thuja|picea|juniperus/.test(id),
    flower = /hydrangea|rosa-|petunia|lavandula|clematis/.test(id);
  const Icon = conifer ? Trees : flower ? Flower2 : Leaf;
  return (
    <span className={'plant-icon ' + (conifer ? 'pine' : flower ? 'bloom' : 'leaf')}>
      <Icon size={20} strokeWidth={1.6} />
    </span>
  );
}
export function PlantTable({ items, select, compact = false }) {
  return items.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Растение</th>
            {!compact && <th>Место</th>}
            <th>Стадия</th>
            <th className="numeric">Кол-во</th>
          </tr>
        </thead>
        <tbody>
          {items.map((b) => (
            <tr key={b.id}>
              <td>
                <button className="plant-cell" onClick={() => select(b)}>
                  <PlantIcon id={b.plant_id} />
                  <span>
                    <strong>{b.name}</strong>
                    <small>{compact ? b.location : 'Партия №' + b.id}</small>
                  </span>
                </button>
              </td>
              {!compact && <td>{b.location}</td>}
              <td>
                <Badge value={b.stage} />
              </td>
              <td className="numeric">{num(b.quantity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>Партий по этому запросу нет.</Empty>
  );
}
export function SearchBox({ value, onChange, placeholder }) {
  return (
    <label className="search">
      <Search size={17} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </label>
  );
}
export function TaskCard({ task, onClick }) {
  return (
    <button className="task-card" onClick={() => onClick(task)}>
      <strong>{task.title}</strong>
      {task.plant_name && <span>{task.plant_name}</span>}
      {task.location && <small>
        <MapPin size={13} />
        {task.location}
      </small>}
      <div className="task-foot">
        <span className="person">
          <i>{task.assignee_name[0]}</i>
          {task.assignee_name}
        </span>
        <span>{task.due_on.split('-').reverse().slice(0, 2).join('.')}</span>
      </div>
    </button>
  );
}
export function useSubmit(save) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false);
  async function submit(e) {
    e.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await save(new FormData(e.currentTarget));
    } catch (err) {
      setError(err.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return { busy, error, submit };
}
export function FormFoot({ error, busy, label = 'Сохранить' }) {
  return (
    <>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="form-foot">
        <button className="btn primary" disabled={busy}>
          {busy ? 'Сохранение…' : label}
        </button>
      </div>
    </>
  );
}
