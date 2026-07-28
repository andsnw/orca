import type {
  LinearTeam,
  LinearWorkflowState,
  LinearLabel,
  LinearMember,
  LinearWorkspaceError,
  LinearWorkspaceSelection
} from '../../shared/types'
import { acquire, release, getClients, isAuthError, clearToken } from './client'
import type { LinearClientForWorkspace } from './client'
import {
  fetchAllTeamLabels,
  fetchAllTeamMembers,
  fetchAllTeamsForWorkspace,
  fetchAllTeamStates
} from './linear-team-pages'

// Why: one viewer lookup per workspace credential is enough for member ordering;
// entries are replaced on credential rotation so a re-auth as another user refreshes.
const viewerIdCache = new Map<string, { revision: number; viewerId: string }>()

async function getCachedViewerId(entry: LinearClientForWorkspace): Promise<string | null> {
  const revision = entry.workspace.credentialRevision ?? 0
  const cached = viewerIdCache.get(entry.workspace.id)
  if (cached && cached.revision === revision) {
    return cached.viewerId
  }

  await acquire()
  try {
    const viewer = await entry.client.viewer
    viewerIdCache.set(entry.workspace.id, { revision, viewerId: viewer.id })
    return viewer.id
  } catch (error) {
    // Member lists must not fail because the viewer lookup did.
    console.warn('[linear] viewer lookup for member ordering failed:', error)
    return null
  } finally {
    release()
  }
}

export function sortMembersViewerFirst(
  members: LinearMember[],
  viewerId: string | null
): LinearMember[] {
  return [...members].sort((a, b) => {
    if (viewerId) {
      if (a.id === viewerId) {
        return b.id === viewerId ? 0 : -1
      }
      if (b.id === viewerId) {
        return 1
      }
    }
    return a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)
  })
}

export async function listTeams(
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearTeam[]> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return []
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        return fetchAllTeamsForWorkspace(entry)
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
          if (workspaceId !== 'all') {
            throw error
          }
        } else {
          console.warn('[linear] listTeams failed:', error)
        }
        return []
      } finally {
        release()
      }
    })
  )
  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function listTeamsOrThrow(
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearTeam[]> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return []
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        return await fetchAllTeamsForWorkspace(entry)
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
        }
        throw error
      } finally {
        release()
      }
    })
  )
  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function listTeamsForAgent(
  workspaceId?: LinearWorkspaceSelection | null
): Promise<{ teams: LinearTeam[]; errors: LinearWorkspaceError[] }> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return { teams: [], errors: [] }
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        return { teams: await fetchAllTeamsForWorkspace(entry), error: null }
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
        }
        return {
          teams: [],
          error: {
            workspaceId: entry.workspace.id,
            workspaceName: entry.workspace.organizationName,
            type: isAuthError(error) ? 'auth' : 'unknown',
            message: error instanceof Error ? error.message : String(error)
          } satisfies LinearWorkspaceError
        }
      } finally {
        release()
      }
    })
  )
  return {
    teams: results.flatMap((result) => result.teams).sort((a, b) => a.name.localeCompare(b.name)),
    errors: results.flatMap((result) => (result.error ? [result.error] : []))
  }
}

export async function getTeamStates(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearWorkflowState[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  await acquire()
  try {
    const team = await entry.client.team(teamId)
    return await fetchAllTeamStates(team)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[linear] getTeamStates failed:', error)
    return []
  } finally {
    release()
  }
}

export async function getTeamStatesOrThrow(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearWorkflowState[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  await acquire()
  try {
    const team = await entry.client.team(teamId)
    return await fetchAllTeamStates(team)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
    }
    throw error
  } finally {
    release()
  }
}

export async function getTeamLabels(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearLabel[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  await acquire()
  try {
    const team = await entry.client.team(teamId)
    return await fetchAllTeamLabels(team)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[linear] getTeamLabels failed:', error)
    return []
  } finally {
    release()
  }
}

export async function getTeamLabelsOrThrow(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearLabel[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  await acquire()
  try {
    const team = await entry.client.team(teamId)
    return await fetchAllTeamLabels(team)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
    }
    throw error
  } finally {
    release()
  }
}

export async function getTeamMembers(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearMember[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  const viewerId = await getCachedViewerId(entry)
  await acquire()
  try {
    const team = await entry.client.team(teamId)
    return sortMembersViewerFirst(await fetchAllTeamMembers(team), viewerId)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[linear] getTeamMembers failed:', error)
    return []
  } finally {
    release()
  }
}

export async function getTeamMembersOrThrow(
  teamId: string,
  workspaceId?: string | null
): Promise<LinearMember[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  const viewerId = await getCachedViewerId(entry)
  await acquire()
  try {
    const team = await entry.client.team(teamId)
    return sortMembersViewerFirst(await fetchAllTeamMembers(team), viewerId)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
    }
    throw error
  } finally {
    release()
  }
}

export async function getViewerForWorkspaceOrThrow(
  workspaceId: string
): Promise<{ id: string; displayName?: string | null; avatarUrl?: string | null }> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new Error('Not connected to Linear')
  }

  await acquire()
  try {
    const viewer = await entry.client.viewer
    return {
      id: viewer.id,
      displayName: viewer.displayName,
      avatarUrl: viewer.avatarUrl ?? undefined
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
    }
    throw error
  } finally {
    release()
  }
}
