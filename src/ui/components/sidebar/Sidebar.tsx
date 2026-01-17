import React from 'react'
import { SidebarHeader } from './SidebarHeader'

function Sidebar() {
  return (
    <div className='w-96 h-full bg-sidebar border-r border-sidebar-border flex flex-col'>
      <SidebarHeader />
      <div>placeholder for sidebar content</div>
    </div>
  )
}

export default Sidebar