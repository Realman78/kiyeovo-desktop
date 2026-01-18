import { useState, useEffect } from 'react'
import './App.css'
import {Lock} from 'lucide-react'
import { Login } from './pages/Login';
import { Main } from './pages/Main';
import { useDispatch } from 'react-redux';
import { setPeerId } from './state/slices/userSlice';

function App() {
  const [initStatus, setInitStatus] = useState('Initializing...');
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dispatch = useDispatch();

  useEffect(() => {
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
}

export default App
