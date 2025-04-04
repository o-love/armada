import { Dispatch, ReactNode, SetStateAction, useEffect, useState } from "react"

import { CssBaseline, styled, ThemeProvider } from "@mui/material"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SnackbarProvider } from "notistack"
import { UserManager, WebStorageStateStore, UserManagerSettings, User } from "oidc-client-ts"
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom"

import NavBar from "./components/NavBar"
import JobSetsContainer from "./containers/JobSetsContainer"
import { JobsTableContainer } from "./containers/lookoutV2/JobsTableContainer"
import { UserManagerContext, useUserManager } from "./oidc"
import { Services, ServicesProvider } from "./services/context"
import { theme } from "./theme/theme"
import { CommandSpec, OidcConfig, withRouter } from "./utils"

const AppContainer = styled("div")({
  display: "flex",
  flexDirection: "column",
  height: "100vh",
})

const AppContent = styled("div")({
  height: "100%",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
})

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 0, retry: false, refetchOnMount: "always" },
  },
})

type AppProps = {
  customTitle: string
  oidcConfig?: OidcConfig
  services: Services
  jobSetsAutoRefreshMs: number | undefined
  jobsAutoRefreshMs: number | undefined
  debugEnabled: boolean
  commandSpecs: CommandSpec[]
}

// Handling authentication on page opening

interface AuthWrapperProps {
  children: ReactNode
  userManager: UserManager | undefined
  isAuthenticated: boolean
}

interface OidcCallbackProps {
  setIsAuthenticated: Dispatch<SetStateAction<boolean>>
}

export const UserManagerProvider = UserManagerContext.Provider

function OidcCallback({ setIsAuthenticated }: OidcCallbackProps): JSX.Element {
  const navigate = useNavigate()
  const userManager = useUserManager()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!userManager) return
    userManager
      .signinRedirectCallback()
      .then(() => {
        setIsAuthenticated(true)
        navigate("/")
      })
      .catch((e) => {
        setError(`${e}`)
        console.error(e)
      })
  }, [navigate, userManager, setIsAuthenticated])

  if (error) return <p>Something went wrong; more details are available in the console.</p>
  return <p>Authenticating...</p>
}

function AuthWrapper({ children, userManager, isAuthenticated }: AuthWrapperProps) {
  useEffect(() => {
    if (!userManager || isAuthenticated) return // Skip if userManager is not available or user is already authenticated

    const handleAuthentication = async () => {
      try {
        const user = await userManager.getUser()
        if (!user || user.expired) {
          await userManager.signinRedirect()
        }
      } catch (error) {
        console.error("Error during authentication:", error)
      }
    }

    ;(async () => {
      await handleAuthentication()
    })()
  }, [userManager, isAuthenticated])

  return <>{children}</>
}

export function createUserManager(config: OidcConfig): UserManager {
  const userManagerSettings: UserManagerSettings = {
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: `${window.location.origin}/oidc`,
    scope: config.scope,
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    loadUserInfo: true,
  }

  return new UserManager(userManagerSettings)
}

// Version 2 of the Lookout UI used to be hosted under /v2, so we try our best
// to redirect users to the new location while preserving the rest of the URL.
const V2Redirect = withRouter(({ router }) => <Navigate to={{ ...router.location, pathname: "/" }} />)

export function App(props: AppProps): JSX.Element {
  const [userManager, setUserManager] = useState<UserManager | undefined>(undefined)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [username, setUsername] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!userManager && props.oidcConfig) {
      const userManagerInstance = createUserManager(props.oidcConfig)
      setUserManager(userManagerInstance)

      userManagerInstance.getUser().then((user: User | null) => {
        if (user) {
          setUsername(user.profile.sub)
        }
      })
    }
  }, [props.oidcConfig])

  useEffect(() => {
    if (props.customTitle) {
      document.title = `${props.customTitle} - Armada Lookout`
    }
  }, [props.customTitle])

  const result = (
    <ThemeProvider theme={theme} defaultMode="light">
      <CssBaseline />
      <SnackbarProvider anchorOrigin={{ horizontal: "right", vertical: "bottom" }} autoHideDuration={8000} maxSnack={3}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <UserManagerProvider value={userManager}>
              <AuthWrapper userManager={userManager} isAuthenticated={isAuthenticated}>
                <ServicesProvider services={props.services}>
                  <AppContainer>
                    <NavBar customTitle={props.customTitle} username={username} />
                    <AppContent>
                      <Routes>
                        <Route
                          path="/"
                          element={
                            <JobsTableContainer
                              getJobsService={props.services.v2GetJobsService}
                              groupJobsService={props.services.v2GroupJobsService}
                              updateJobsService={props.services.v2UpdateJobsService}
                              runInfoService={props.services.v2RunInfoService}
                              jobSpecService={props.services.v2JobSpecService}
                              cordonService={props.services.v2CordonService}
                              debug={props.debugEnabled}
                              autoRefreshMs={props.jobsAutoRefreshMs}
                              commandSpecs={props.commandSpecs}
                            />
                          }
                        />
                        <Route
                          path="/job-sets"
                          element={
                            <JobSetsContainer
                              v2GroupJobsService={props.services.v2GroupJobsService}
                              v2UpdateJobSetsService={props.services.v2UpdateJobSetsService}
                              jobSetsAutoRefreshMs={props.jobSetsAutoRefreshMs}
                            />
                          }
                        />
                        <Route path="/oidc" element={<OidcCallback setIsAuthenticated={setIsAuthenticated} />} />
                        <Route path="/v2" element={<V2Redirect />} />
                        <Route
                          path="*"
                          element={
                            // This wildcard route ensures that users who follow old
                            // links to /job-sets or /jobs see something other than
                            // a blank page.
                            <Navigate to="/" />
                          }
                        />
                      </Routes>
                    </AppContent>
                  </AppContainer>
                </ServicesProvider>
              </AuthWrapper>
            </UserManagerProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </SnackbarProvider>
    </ThemeProvider>
  )

  return result
}
