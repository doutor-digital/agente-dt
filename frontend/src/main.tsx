import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ToastProvider } from './context/ToastContext.tsx';
import { ThemeProvider } from './context/ThemeContext.tsx';
import './index.css';


// Depois de um deploy, um navegador com o index.html antigo pede pedaços (chunks)
// que não existem mais e a tela fica em branco. O Vite avisa por este evento;
// recarregar uma vez resolve sem o usuário precisar saber o que é cache.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  const chave = 'agente-dt:reload-apos-preload-error';
  if (sessionStorage.getItem(chave) === location.href) return; // evita loop
  sessionStorage.setItem(chave, location.href);
  window.location.reload();
});

async function montar() {
  let raiz = <App />;
  // Prévia com dados de mentira, só no servidor de desenvolvimento (o Vite remove este ramo do build).
  if (import.meta.env.DEV && window.location.pathname.startsWith('/__previa/disparo')) {
    const { PreviaDisparo } = await import('./previa/disparo.tsx');
    raiz = <PreviaDisparo />;
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <ToastProvider>{raiz}</ToastProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
void montar();
