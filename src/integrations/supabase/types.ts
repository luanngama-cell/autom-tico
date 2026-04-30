export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_tokens: {
        Row: {
          connection_id: string
          created_at: string
          id: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          token_hash: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          id?: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          token_hash: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          id?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_tokens_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "sql_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      bi_deliveries: {
        Row: {
          changed_sections: string[]
          created_at: string
          destination_id: string
          duration_ms: number | null
          error_message: string | null
          http_status: number | null
          id: string
          payload_bytes: number | null
          payload_kind: string
          request_ip: string | null
          rows_affected: number
          status: string
          triggered_by: string
        }
        Insert: {
          changed_sections?: string[]
          created_at?: string
          destination_id: string
          duration_ms?: number | null
          error_message?: string | null
          http_status?: number | null
          id?: string
          payload_bytes?: number | null
          payload_kind?: string
          request_ip?: string | null
          rows_affected?: number
          status: string
          triggered_by?: string
        }
        Update: {
          changed_sections?: string[]
          created_at?: string
          destination_id?: string
          duration_ms?: number | null
          error_message?: string | null
          http_status?: number | null
          id?: string
          payload_bytes?: number | null
          payload_kind?: string
          request_ip?: string | null
          rows_affected?: number
          status?: string
          triggered_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "bi_deliveries_destination_id_fkey"
            columns: ["destination_id"]
            isOneToOne: false
            referencedRelation: "bi_destinations"
            referencedColumns: ["id"]
          },
        ]
      }
      bi_destination_tokens: {
        Row: {
          created_at: string
          destination_id: string
          id: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          token_hash: string
          token_prefix: string
        }
        Insert: {
          created_at?: string
          destination_id: string
          id?: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          token_hash: string
          token_prefix: string
        }
        Update: {
          created_at?: string
          destination_id?: string
          id?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          token_hash?: string
          token_prefix?: string
        }
        Relationships: [
          {
            foreignKeyName: "bi_destination_tokens_destination_id_fkey"
            columns: ["destination_id"]
            isOneToOne: false
            referencedRelation: "bi_destinations"
            referencedColumns: ["id"]
          },
        ]
      }
      bi_destinations: {
        Row: {
          allowed_ips: string[]
          bi_script_id: string | null
          created_at: string
          description: string | null
          enabled: boolean
          endpoint_url: string
          id: string
          include_patient_registry: boolean
          last_error: string | null
          last_pushed_at: string | null
          last_status: string | null
          name: string
          push_interval_minutes: number
          source_database_name: string | null
          updated_at: string
        }
        Insert: {
          allowed_ips?: string[]
          bi_script_id?: string | null
          created_at?: string
          description?: string | null
          enabled?: boolean
          endpoint_url: string
          id?: string
          include_patient_registry?: boolean
          last_error?: string | null
          last_pushed_at?: string | null
          last_status?: string | null
          name: string
          push_interval_minutes?: number
          source_database_name?: string | null
          updated_at?: string
        }
        Update: {
          allowed_ips?: string[]
          bi_script_id?: string | null
          created_at?: string
          description?: string | null
          enabled?: boolean
          endpoint_url?: string
          id?: string
          include_patient_registry?: boolean
          last_error?: string | null
          last_pushed_at?: string | null
          last_status?: string | null
          name?: string
          push_interval_minutes?: number
          source_database_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bi_destinations_bi_script_id_fkey"
            columns: ["bi_script_id"]
            isOneToOne: false
            referencedRelation: "bi_scripts"
            referencedColumns: ["id"]
          },
        ]
      }
      bi_query_metrics: {
        Row: {
          cache_hit: boolean
          created_at: string
          destination_id: string | null
          duration_ms: number
          error: string | null
          id: string
          row_count: number
          sql_hash: string
          sql_preview: string
        }
        Insert: {
          cache_hit?: boolean
          created_at?: string
          destination_id?: string | null
          duration_ms: number
          error?: string | null
          id?: string
          row_count?: number
          sql_hash: string
          sql_preview: string
        }
        Update: {
          cache_hit?: boolean
          created_at?: string
          destination_id?: string | null
          duration_ms?: number
          error?: string | null
          id?: string
          row_count?: number
          sql_hash?: string
          sql_preview?: string
        }
        Relationships: []
      }
      bi_scripts: {
        Row: {
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          last_duration_ms: number | null
          last_error: string | null
          last_row_count: number | null
          last_run_at: string | null
          last_status: string | null
          name: string
          run_interval_minutes: number
          sql_code: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          last_duration_ms?: number | null
          last_error?: string | null
          last_row_count?: number | null
          last_run_at?: string | null
          last_status?: string | null
          name: string
          run_interval_minutes?: number
          sql_code: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          last_duration_ms?: number | null
          last_error?: string | null
          last_row_count?: number | null
          last_run_at?: string | null
          last_status?: string | null
          name?: string
          run_interval_minutes?: number
          sql_code?: string
          updated_at?: string
        }
        Relationships: []
      }
      bi_snapshots: {
        Row: {
          destination_id: string
          generated_at: string
          payload: Json
          payload_hash: string | null
          section_hashes: Json
          source_watermarks: Json
          updated_at: string
        }
        Insert: {
          destination_id: string
          generated_at?: string
          payload?: Json
          payload_hash?: string | null
          section_hashes?: Json
          source_watermarks?: Json
          updated_at?: string
        }
        Update: {
          destination_id?: string
          generated_at?: string
          payload?: Json
          payload_hash?: string | null
          section_hashes?: Json
          source_watermarks?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bi_snapshots_destination_id_fkey"
            columns: ["destination_id"]
            isOneToOne: true
            referencedRelation: "bi_destinations"
            referencedColumns: ["id"]
          },
        ]
      }
      custom_apis: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_public: boolean
          last_test_result: Json | null
          last_tested_at: string | null
          method: string
          name: string
          query_definition: Json
          route: string
          status: string
          sync_table_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_public?: boolean
          last_test_result?: Json | null
          last_tested_at?: string | null
          method?: string
          name: string
          query_definition?: Json
          route: string
          status?: string
          sync_table_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_public?: boolean
          last_test_result?: Json | null
          last_tested_at?: string | null
          method?: string
          name?: string
          query_definition?: Json
          route?: string
          status?: string
          sync_table_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "custom_apis_sync_table_id_fkey"
            columns: ["sync_table_id"]
            isOneToOne: false
            referencedRelation: "sync_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      mv_registry: {
        Row: {
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          last_refresh_duration_ms: number | null
          last_refresh_error: string | null
          last_refresh_status: string | null
          last_refreshed_at: string | null
          name: string
          refresh_interval_minutes: number
          row_count: number | null
          sql_definition: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          last_refresh_duration_ms?: number | null
          last_refresh_error?: string | null
          last_refresh_status?: string | null
          last_refreshed_at?: string | null
          name: string
          refresh_interval_minutes?: number
          row_count?: number | null
          sql_definition: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          last_refresh_duration_ms?: number | null
          last_refresh_error?: string | null
          last_refresh_status?: string | null
          last_refreshed_at?: string | null
          name?: string
          refresh_interval_minutes?: number
          row_count?: number | null
          sql_definition?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      sql_connections: {
        Row: {
          created_at: string
          database_name: string
          encrypt: boolean
          host: string
          id: string
          last_seen_at: string | null
          name: string
          notes: string | null
          port: number
          status: string
          trust_server_cert: boolean
          updated_at: string
          username: string
        }
        Insert: {
          created_at?: string
          database_name: string
          encrypt?: boolean
          host: string
          id?: string
          last_seen_at?: string | null
          name: string
          notes?: string | null
          port?: number
          status?: string
          trust_server_cert?: boolean
          updated_at?: string
          username: string
        }
        Update: {
          created_at?: string
          database_name?: string
          encrypt?: boolean
          host?: string
          id?: string
          last_seen_at?: string | null
          name?: string
          notes?: string | null
          port?: number
          status?: string
          trust_server_cert?: boolean
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
      sync_logs: {
        Row: {
          connection_id: string | null
          created_at: string
          details: Json | null
          duration_ms: number | null
          event: string
          id: string
          level: string
          message: string | null
          rows_deleted: number
          rows_inserted: number
          rows_updated: number
          sync_table_id: string | null
        }
        Insert: {
          connection_id?: string | null
          created_at?: string
          details?: Json | null
          duration_ms?: number | null
          event: string
          id?: string
          level?: string
          message?: string | null
          rows_deleted?: number
          rows_inserted?: number
          rows_updated?: number
          sync_table_id?: string | null
        }
        Update: {
          connection_id?: string | null
          created_at?: string
          details?: Json | null
          duration_ms?: number | null
          event?: string
          id?: string
          level?: string
          message?: string | null
          rows_deleted?: number
          rows_inserted?: number
          rows_updated?: number
          sync_table_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_logs_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "sql_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_logs_sync_table_id_fkey"
            columns: ["sync_table_id"]
            isOneToOne: false
            referencedRelation: "sync_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_tables: {
        Row: {
          connection_id: string
          created_at: string
          enabled: boolean
          excluded: boolean
          excluded_at: string | null
          excluded_reason: string | null
          has_rowversion: boolean
          id: string
          last_checksum: string | null
          last_error: string | null
          last_rowversion: string | null
          last_synced_at: string | null
          primary_keys: string[]
          row_count: number
          schema_hash: string | null
          schema_name: string
          strategy: string
          table_name: string
          updated_at: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          enabled?: boolean
          excluded?: boolean
          excluded_at?: string | null
          excluded_reason?: string | null
          has_rowversion?: boolean
          id?: string
          last_checksum?: string | null
          last_error?: string | null
          last_rowversion?: string | null
          last_synced_at?: string | null
          primary_keys?: string[]
          row_count?: number
          schema_hash?: string | null
          schema_name?: string
          strategy?: string
          table_name: string
          updated_at?: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          enabled?: boolean
          excluded?: boolean
          excluded_at?: string | null
          excluded_reason?: string | null
          has_rowversion?: boolean
          id?: string
          last_checksum?: string | null
          last_error?: string | null
          last_rowversion?: string | null
          last_synced_at?: string | null
          primary_keys?: string[]
          row_count?: number
          schema_hash?: string | null
          schema_name?: string
          strategy?: string
          table_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_tables_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "sql_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      synced_rows: {
        Row: {
          data: Json
          id: string
          pk: Json
          pk_hash: string
          row_hash: string
          sync_table_id: string
          updated_at: string
        }
        Insert: {
          data: Json
          id?: string
          pk: Json
          pk_hash: string
          row_hash: string
          sync_table_id: string
          updated_at?: string
        }
        Update: {
          data?: Json
          id?: string
          pk?: Json
          pk_hash?: string
          row_hash?: string
          sync_table_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "synced_rows_sync_table_id_fkey"
            columns: ["sync_table_id"]
            isOneToOne: false
            referencedRelation: "sync_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      execute_bi_script: { Args: { _sql: string }; Returns: Json }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      refresh_due_mvs: { Args: never; Returns: Json }
      refresh_mv: { Args: { _name: string }; Returns: Json }
      validate_bi_cron_token: { Args: { _token: string }; Returns: boolean }
      validate_maintenance_token: { Args: { _token: string }; Returns: boolean }
    }
    Enums: {
      app_role: "master"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["master"],
    },
  },
} as const
