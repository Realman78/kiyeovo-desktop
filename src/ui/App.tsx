import { useState, useEffect } from 'react'
import './App.css'
import { Login } from './pages/Login';
import { Main } from './pages/Main';
import { useDispatch } from 'react-redux';
import { setPeerId } from './state/slices/userSlice';

function App() {
  const [initStatus, setInitStatus] = useState('Initializing...');
  const [isInitialized, setIsInitialized] = useState(false);

  const dispatch = useDispatch();

  useEffect(() => {
    let isMounted = true;

    const loadInitState = async () => {
      try {
        const initState = await window.kiyeovoAPI.getInitState();
        if (!isMounted) return;
        if (initState.status) {
          setInitStatus(initState.status.message);
          if (initState.status.stage === 'peerId') {
            dispatch(setPeerId(initState.status.message as string));
          }
        }
        if (initState.error) {
          setInitStatus(initState.error);
        }
        if (initState.initialized) {
          setIsInitialized(true);
          setInitStatus('Initialized successfully!');
        }
      } catch {
        // ignore and rely on live events
      }
    };

    void loadInitState();

    const unsubStatus = window.kiyeovoAPI.onInitStatus((status) => {
      if (status.stage === 'peerId') {
        dispatch(setPeerId(status.message as string));
        return;
      }
      setInitStatus(status.message);
    });

    const unsubComplete = window.kiyeovoAPI.onInitComplete(() => {
      setIsInitialized(true);
      setInitStatus('Initialized successfully!');
    });

    const unsubError = window.kiyeovoAPI.onInitError(() => {
      // Error handling can be added here if needed
    });


    return () => {
      isMounted = false;
      unsubStatus();
      unsubComplete();
      unsubError();
    };
  }, [dispatch]);

  return <div className='w-full h-full'>
    {isInitialized ? <Main /> : <Login initStatus={initStatus} />}
  </div>
}

export default App
