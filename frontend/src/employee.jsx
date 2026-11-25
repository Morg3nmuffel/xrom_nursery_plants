import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LogOut, RefreshCw } from 'lucide-react';
import { api, Brand } from './shared';
import { FormFoot, Modal, TaskBoard, TaskDetails, useSubmit } from './components';

function EmployeeTask({ task, close, changed }) {
  const starting = task.status === 'todo';
  const { submit, error, busy } = useSubmit(async () => {
    const action = starting ? 'start' : 'complete';
    const updated = await api('employee/tasks/' + task.id + '/' + action, { method: 'POST' });
    await changed(updated);
  });
  return (
    <Modal
      title="Задача"
      close={() => {
        if (!busy) close();
      }}
    >
      <TaskDetails task={task} />
      {task.status !== 'done' && (
        <form className="edit-form task-action" onSubmit={submit}>
          <FormFoot busy={busy} error={error} label={starting ? 'Начать выполнение' : 'Завершить работу'} />
        </form>
      )}
    </Modal>
  );
}

function EmployeeApp() {
  const [board, setBoard] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const response = await api('employee/tasks');
      if (sequence.current === request) setBoard(response);
    } catch (err) {
      if (sequence.current === request) setError(err.message);
    } finally {
      if (sequence.current === request) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, 30_000);
    return () => {
      ++sequence.current;
      clearInterval(timer);
    };
  }, [reload]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function logout() {
    setSigningOut(true);
    try {
      await api('logout', { method: 'POST' });
      location.replace('/');
    } catch (err) {
      setError(err.message);
      setSigningOut(false);
    }
  }

  async function changed(task) {
    setSelectedId(null);
    setNotice(task.status === 'done' ? 'Задача завершена.' : 'Задача в работе.');
    await reload();
  }

  const tasks = board?.items || [];
  const selected = tasks.find((task) => task.id === selectedId);
  return (
    <>
      <header className="employee-header">
        <Brand />
        <button className="btn" onClick={logout} disabled={signingOut}>
          <LogOut size={16} /> Выйти
        </button>
      </header>
      <main className="main employee-main">
        <div className="page-heading">
          <div>
            <h1>Мои задачи</h1>
            {board && <p>{board.employee.name}</p>}
          </div>
          <button className="btn" onClick={reload} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'spin' : undefined} />
            {loading ? 'Обновление' : 'Обновить'}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <TaskBoard
          tasks={tasks}
          onSelect={(task) => setSelectedId(task.id)}
          personal
          loading={loading && !board}
        />
      </main>
      {selected && (
        <EmployeeTask key={selected.id} task={selected} close={() => setSelectedId(null)} changed={changed} />
      )}
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')).render(<EmployeeApp />);
