import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Eye, EyeOff, LockKeyhole, UserRound, Leaf } from 'lucide-react';
import { Brand, api } from './shared';

function Login() {
  const [shown, show] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api('login', {
        method: 'POST',
        body: { username: form.get('username').trim(), password: form.get('password') },
      });
      location.replace('/');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-scene">
        <Brand />
        <div className="scene-title">
          <span className="scene-mark">
            <Leaf size={17} /> XROM GROUP
          </span>
          <h2>
            Питомник
            <br />
            растений
          </h2>
        </div>
      </section>
      <section className="login-side">
        <div className="login-box">
          <span className="lock-icon">
            <LockKeyhole size={24} />
          </span>
          <h1>Вход в питомник</h1>
          <p>Войдите под учётной записью администратора.</p>
          <form onSubmit={submit}>
            <label>
              Логин
              <div className="input-icon">
                <UserRound size={17} />
                <input
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  required
                  autoFocus
                  maxLength={160}
                />
              </div>
            </label>
            <div>
              <label htmlFor="admin-password">Пароль</label>
              <div className="input-icon">
                <LockKeyhole size={17} />
                <input
                  id="admin-password"
                  name="password"
                  type={shown ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="iconbtn"
                  aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'}
                  onClick={() => show(!shown)}
                >
                  {shown ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="btn primary wide" disabled={busy}>
              {busy ? 'Выполняется вход…' : 'Войти'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')).render(<Login />);
