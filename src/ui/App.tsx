import { useState, useEffect } from 'react'
import './App.css'
import {Lock} from 'lucide-react'
import { Login } from './pages/Login';
import { Main } from './pages/Main';

function App() {
  const [initStatus, setInitStatus] = useState('Initializing...');
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubStatus = window.kiyeovoAPI.onInitStatus((status) => {
      setInitStatus(status.message);
    });

    const unsubComplete = window.kiyeovoAPI.onInitComplete(() => {
      setIsInitialized(true);
      setInitStatus('Initialized successfully!');
    });

    const unsubError = window.kiyeovoAPI.onInitError((errorMsg) => {
      setError(errorMsg);
    });

    return () => {
      unsubStatus();
      unsubComplete();
      unsubError();
    };
  }, []);

  return <div className='w-full h-full'>
    {isInitialized ? <Main /> : <Login initStatus={initStatus} />}
  </div>

  return (
    <div className='w-full h-full bg-background cyber-grid'>

      <div className="w-16 h-16 rounded-full border border-primary/50 flex items-center justify-center glow-border">
            <Lock className="w-8 h-8 text-primary" />
          </div>
      <div style={{ padding: '2rem' }}>
        <h1>Kiyeovo Desktop</h1>
        <button className="btn">Click me</button>

        {error ? (
          <div style={{ color: 'red', padding: '1rem', border: '1px solid red', borderRadius: '4px' }}>
            <strong>Error:</strong> {error}
          </div>
        ) : isInitialized ? (
          <div style={{ color: 'green' }}>
            <p>✓ {initStatus}</p>
            <p>P2P node is ready!</p>
          </div>
        ) : (
          <div>
            <p>{initStatus}</p>
            <div style={{ marginTop: '1rem' }}>
              <div className="loader" style={{
                border: '4px solid #f3f3f3',
                borderTop: '4px solid #3498db',
                borderRadius: '50%',
                width: '40px',
                height: '40px',
                animation: 'spin 1s linear infinite',
              }} />
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}

export default App
