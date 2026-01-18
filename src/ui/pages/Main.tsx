import Sidebar from '../components/sidebar/Sidebar'
import ChatWrapper from '../components/chat/ChatWrapper'

export const Main = () => {
  return (
    <div className='h-screen w-screen flex overflow-hidden'>
      <Sidebar />
      <div className='flex-1'>
        <ChatWrapper />
      </div>
    </div>
  )
}
