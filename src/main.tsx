import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App';
import { Home } from './ui/Home';
import { useAppStore } from './store/appStore';
import './index.css';

function Screen() {
  const screen = useAppStore((s) => s.screen);
  switch (screen) {
    case 'solo':
      return <App />;
    default:
      return <Home />;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Screen />
  </StrictMode>,
);
