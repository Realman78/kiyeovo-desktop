import { useState, useEffect } from 'react'
import './App.css'
import { PasswordPrompt } from './components/PasswordPrompt'

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

  return (
    <>
      <PasswordPrompt />

      <div style={{ padding: '2rem' }}>
        <h1>Kiyeovo Desktop</h1>

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
    </>
  )
}

export default App
