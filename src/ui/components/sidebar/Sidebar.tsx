import { type FC } from 'react'
import { SidebarHeader } from './header/SidebarHeader'
import { ChatList } from './chats/ChatList'
import { SidebarFooter } from './footer/SidebarFooter'

export const Sidebar: FC = () => {
  return (
    <div className='w-96 h-full bg-sidebar border-r border-sidebar-border flex flex-col'>
      <SidebarHeader />
      <ChatList />
      <SidebarFooter />
    </div>
  )
}

export default Sidebar