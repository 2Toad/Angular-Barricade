/*
 * Angular-Barricade
 * Copyright (C)2014 2Toad, LLC.
 * https://github.com/2Toad/Angular-Barricade
 *
 * Version: 1.2.0
 * License: MIT
 */

(function () {
    'use strict';

    angular.module('ttBarricade', [

    ]).factory('barricade', ['$q', '$http', '$cookies', '$rootScope', '$route', '$window',
        function ($q, $http, $cookies, $rootScope, $route, $window) {
            var rejectionStatusCode = "barricade",
                handledStatusCodes = [rejectionStatusCode, 401, 403, 419],
                service = {
                    authenticated: false,
                    expired: false,
                    tokenRequestUrl: undefined,
                    tokenInvalidateUrl: undefined,
                    loginTemplateUrl: undefined,
                    serverErrorTemplateUrl: undefined,
                    noAuth: undefined,
                    lastNoAuth: undefined
                };

            // WARNING: HERE BE DRAGONS!
            // We add a reference to $rootScope to get around the dependency recursion that
            // is caused when trying to inject barricade into the barricade.interceptor service.
            // It's hacky, and it made me throw up in my mouth a little, but it works.
            $rootScope.barricade = service;

            return angular.extend(service, {
                init: initialize,
                login: login,
                logout: logout,
                statusHandled: statusHandled,
                httpRequestHandler: httpRequestHandler,
                httpResponseErrorHandler: httpResponseErrorHandler
            });

            function initialize(restoreSession, config) {
                addExclusions(config);

                angular.extend(service, config);

                if (restoreSession) restoreLastSession();

                $rootScope.$on('$routeChangeStart', function (event, next, current) {
                    service.noAuth = next.noAuth;
                    service.lastNoAuth = current
                        ? current.noAuth
                            ? current.originalPath
                            : service.lastNoAuth
                        : next.noAuth
                            ? next.originalPath
                            : service.lastNoAuth;
                });

                function addExclusions(config) {
                    service.exclusions = [];

                    angular.forEach(config.exclusions, function (exclusion) {
                        excludeUrl(exclusion);
                    });
                    delete config.exclusions;

                    excludeUrl(config.serverErrorTemplateUrl);
                    excludeUrl(config.loginTemplateUrl);
                    excludeUrl(config.tokenRequestUrl);

                    function excludeUrl(url) {
                        var regex = typeof url == 'string' ? createRegex(url) : url;
                        service.exclusions.push(regex);

                        function createRegex(url) {
                            return new RegExp('^' + url.replace(/[-[\]{}()*+?.,\\/^$|#\s]/g, '\\$&') + '$', 'i');
                        }
                    }
                }

                function restoreLastSession() {
                    var cookie = $cookies.getObject('barricade');
                    if (!cookie) return;

                    if (cookie.expiration < now()) setStatus(419);
                    else {
                        setHeader(cookie.token);
                        setStatus(200);
                    }
                }
            }

            function login(username, password, tokenRequestUrl) {
                return $http.post(
                    tokenRequestUrl || service.tokenRequestUrl, {
                        username: username,
                        password: password
                    }
                ).success(loginSuccessful);

                function loginSuccessful(data) {
                    startSession(data.access_token, data.expires_in);
                    setStatus(200);

                    // Reload after a successful login so Angular will fetch any URLs that
                    // were blocked by Barricade (e.g., API calls)
                    $route.reload();

                    function startSession(accessToken, accessTokenDuration) {
                        var cookie = {
                            token: accessToken,
                            expiration: now() + (accessTokenDuration * 1000)
                        };

                        setHeader(cookie.token);
                        $cookies.putObject('barricade', cookie);
                    }
                }
            }

            function logout(tokenInvalidateUrl) {
                return $http.delete(tokenInvalidateUrl || service.tokenInvalidateUrl)
                    .finally(logoutFinished);

                function logoutFinished() {
                    endSession();

                    // For security purposes, we're not using $route.reload() here. We want the
                    // entire app to be re-instantiated (e.g., window, scopes, controllers), as
                    // though the user had never been logged in
                    $window.location.reload();
                }
            }

            function statusHandled(status) {
                return handledStatusCodes.indexOf(status) !== -1;
            }

            function httpRequestHandler(request) {
                if (dontBlock(request.url)) return request;

                // Block this request from going to the server
                console.warn('Barricade: blocking "' + request.url + '"');
                return $q.reject({ status: rejectionStatusCode });

                function dontBlock(url) {
                    return service.authenticated || service.noAuth || service.exclusions
                        .some(function (regex) {
                            return regex.test(url);
                        });
                }
            }

            function httpResponseErrorHandler(rejection) {
                // Is the rejection from Barricade?
                if (rejection.status === rejectionStatusCode) return $q.when(rejection);

                service.serverErrorHandler && service.serverErrorHandler(rejection);
                var status = checkForExpiredToken(rejection.status);
                setStatus(status);
                status === 401 || status === 419 && endSession();

                // Tell Angular to reject this request
                return $q.reject(rejection);

                function checkForExpiredToken(status) {
                    // If the client is authenticated, but the server is returning
                    // 401, that means the token has expired
                    return status === 401 && service.authenticated ? 419 : rejection.status;
                }
            }

            function endSession() {
                delete $http.defaults.headers.common.Authorization;
                $cookies.remove('barricade');
            }

            function now() {
                return (new Date()).getTime();
            }

            function setStatus(status) {
                if ([200, 401, 419].indexOf(status) === -1) return;
                service.expired = status === 419;
                service.authenticated = !service.expired && status !== 401;
            }

            function setHeader(bearerToken) {
                $http.defaults.headers.common.Authorization = 'Bearer ' + bearerToken;
            }
        }
    ]).factory('barricade.interceptor', ['$rootScope',
        function ($rootScope) {
            return {
                request: function (config) {
                    return $rootScope.barricade.httpRequestHandler(config);
                },
                responseError: function (rejection) {
                    return $rootScope.barricade.httpResponseErrorHandler(rejection);
                }
            };
        }
    ]).config(['$httpProvider',
        function ($httpProvider) {
            $httpProvider.interceptors.push('barricade.interceptor');
        }
    ]);
}());
