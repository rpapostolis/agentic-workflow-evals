/**
 * Application configuration
 * 
 * This module provides access to environment variables and feature flags
 * used throughout the application.
 */

/**
 * Flight configuration for UI features
 *
 * This object contains feature flags that control the visibility and behavior
 * of various UI elements. These are purely UX controls and do not affect
 * backend evaluator behavior.
 */
export const flightConfigurationForUI = {} as const;

/**
 * API base URL for backend communication
 */
export const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000/api";
