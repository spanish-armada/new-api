/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { UsersPrimaryButtons } from '../users-primary-buttons'
import { UsersProvider } from '../users-provider'

afterEach(() => {
  cleanup()
  useAuthStore.getState().auth.reset()
})

it('shows Add User to the root user', () => {
  useAuthStore.getState().auth.setUser({ id: 1, username: 'root', role: ROLE.SUPER_ADMIN })

  render(
    <UsersProvider>
      <UsersPrimaryButtons />
    </UsersProvider>
  )

  expect(screen.getByRole('button', { name: 'Add User' })).toBeInTheDocument()
})

it('hides Add User from an admin user', () => {
  useAuthStore.getState().auth.setUser({ id: 2, username: 'admin', role: ROLE.ADMIN })

  render(
    <UsersProvider>
      <UsersPrimaryButtons />
    </UsersProvider>
  )

  expect(
    screen.queryByRole('button', { name: 'Add User' })
  ).not.toBeInTheDocument()
})
