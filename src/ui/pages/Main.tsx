import React from 'react'
import Sidebar from '../components/sidebar/Sidebar'

export const Main = () => {
  return (
    <div className='h-screen w-screen flex overflow-hidden'>
      <Sidebar />
      <div className='flex-1'>
        <div>placeholder for main content</div>
      </div>
    </div>
  )
}
