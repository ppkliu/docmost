import axios, { AxiosInstance } from "axios";
import APP_ROUTE from "@/lib/app-route.ts";
import {
  getBackendUrl,
  isCloud,
  stripPublicPath,
  withPublicPath,
} from "@/lib/config.ts";

const api: AxiosInstance = axios.create({
  baseURL: getBackendUrl(),
  withCredentials: true,
});

api.interceptors.response.use(
  (response) => {
    // we need the response headers for these endpoints
    const exemptEndpoints = [
      withPublicPath("/api/pages/export"),
      withPublicPath("/api/spaces/export"),
    ];
    if (response.request.responseURL) {
      const path = new URL(response.request.responseURL)?.pathname;
      if (path && exemptEndpoints.includes(path)) {
        return response;
      }
    }

    return response.data;
  },
  (error) => {
    if (error.response) {
      switch (error.response.status) {
        case 401: {
          const url = new URL(error.request.responseURL)?.pathname;
          if (url === withPublicPath("/api/auth/collab-token")) return;
          if (window.location.pathname.startsWith(withPublicPath("/share/")))
            return;

          // Handle unauthorized error
          redirectToLogin();
          break;
        }
        case 403:
          // Handle forbidden error
          break;
        case 404:
          // Handle not found error
          if (
            error.response.data.message
              .toLowerCase()
              .includes("workspace not found")
          ) {
            console.log("workspace not found");
            const setupPath = withPublicPath(APP_ROUTE.AUTH.SETUP);
            if (!isCloud() && window.location.pathname != setupPath) {
              window.location.href = setupPath;
            }
          }
          break;
        case 500:
          // Handle internal server error
          break;
        default:
          break;
      }
    }
    return Promise.reject(error);
  },
);

function redirectToLogin() {
  const currentPath = stripPublicPath(window.location.pathname);
  const exemptPaths = [
    APP_ROUTE.AUTH.LOGIN,
    APP_ROUTE.AUTH.SIGNUP,
    APP_ROUTE.AUTH.FORGOT_PASSWORD,
    APP_ROUTE.AUTH.PASSWORD_RESET,
    APP_ROUTE.AUTH.MFA_CHALLENGE,
    APP_ROUTE.AUTH.MFA_SETUP_REQUIRED,
    "/invites",
  ];
  if (!exemptPaths.some((path) => currentPath.startsWith(path))) {
    const redirectTo = currentPath;
    const loginPath = withPublicPath(APP_ROUTE.AUTH.LOGIN);
    if (redirectTo === APP_ROUTE.HOME) {
      window.location.href = loginPath;
    } else {
      const params = new URLSearchParams({ redirect: redirectTo });
      window.location.href = `${loginPath}?${params.toString()}`;
    }
  }
}

export default api;
