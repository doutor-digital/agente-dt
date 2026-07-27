import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ToastProvider } from './context/ToastContext.tsx';
import { ThemeProvider } from './context/ThemeContext.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
