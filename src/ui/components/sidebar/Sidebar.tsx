import React, { type FC } from 'react'
import { SidebarHeader } from './SidebarHeader'
import { ChatList } from './ChatList'

export const Sidebar: FC = () => {
  return (
    <div className='w-96 h-full bg-sidebar border-r border-sidebar-border flex flex-col'>
      <SidebarHeader />
      <ChatList />
    </div>
  )
}

export default Sidebar