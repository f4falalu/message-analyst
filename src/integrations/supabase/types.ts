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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      ai_providers: {
        Row: {
          api_key: string | null
          auth_style: string
          base_url: string
          created_at: string
          id: string
          is_active: boolean
          label: string
          model: string
          notes: string | null
          supports_pdf: boolean
          updated_at: string
        }
        Insert: {
          api_key?: string | null
          auth_style?: string
          base_url: string
          created_at?: string
          id?: string
          is_active?: boolean
          label: string
          model: string
          notes?: string | null
          supports_pdf?: boolean
          updated_at?: string
        }
        Update: {
          api_key?: string | null
          auth_style?: string
          base_url?: string
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          model?: string
          notes?: string | null
          supports_pdf?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      attachments: {
        Row: {
          created_at: string
          extracted: Json | null
          filename: string
          id: string
          import_id: string
          message_seq: number | null
          mime_type: string | null
          ocr_error: string | null
          ocr_status: string
          processed_at: string | null
          raw_text: string | null
          size_bytes: number | null
          storage_path: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          extracted?: Json | null
          filename: string
          id?: string
          import_id: string
          message_seq?: number | null
          mime_type?: string | null
          ocr_error?: string | null
          ocr_status?: string
          processed_at?: string | null
          raw_text?: string | null
          size_bytes?: number | null
          storage_path: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          extracted?: Json | null
          filename?: string
          id?: string
          import_id?: string
          message_seq?: number | null
          mime_type?: string | null
          ocr_error?: string | null
          ocr_status?: string
          processed_at?: string | null
          raw_text?: string | null
          size_bytes?: number | null
          storage_path?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attachments_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "imports"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          created_at: string
          display_name: string
          id: string
          import_id: string
          message_count: number
          phone: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          display_name: string
          id?: string
          import_id: string
          message_count?: number
          phone?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          import_id?: string
          message_count?: number
          phone?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "imports"
            referencedColumns: ["id"]
          },
        ]
      }
      imports: {
        Row: {
          chat_parsed: boolean
          created_at: string
          filename: string
          id: string
          message_count: number
          notes: string | null
          status: string
          total_files: number
          updated_at: string
          user_id: string | null
        }
        Insert: {
          chat_parsed?: boolean
          created_at?: string
          filename: string
          id?: string
          message_count?: number
          notes?: string | null
          status?: string
          total_files?: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          chat_parsed?: boolean
          created_at?: string
          filename?: string
          id?: string
          message_count?: number
          notes?: string | null
          status?: string
          total_files?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      messages: {
        Row: {
          attachment_filename: string | null
          body: string | null
          created_at: string
          id: string
          import_id: string
          sender: string | null
          sender_phone: string | null
          sent_at: string | null
          seq: number
          user_id: string | null
        }
        Insert: {
          attachment_filename?: string | null
          body?: string | null
          created_at?: string
          id?: string
          import_id: string
          sender?: string | null
          sender_phone?: string | null
          sent_at?: string | null
          seq: number
          user_id?: string | null
        }
        Update: {
          attachment_filename?: string | null
          body?: string | null
          created_at?: string
          id?: string
          import_id?: string
          sender?: string | null
          sender_phone?: string | null
          sent_at?: string | null
          seq?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "imports"
            referencedColumns: ["id"]
          },
        ]
      }
      name_mappings: {
        Row: {
          active: boolean
          canonical: string
          created_at: string
          id: string
          kind: string
          notes: string | null
          pattern: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          canonical: string
          created_at?: string
          id?: string
          kind: string
          notes?: string | null
          pattern: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          canonical?: string
          created_at?: string
          id?: string
          kind?: string
          notes?: string | null
          pattern?: string
          updated_at?: string
        }
        Relationships: []
      }
      processing_events: {
        Row: {
          attachment_id: string | null
          confidence: number | null
          created_at: string
          doc_type: string | null
          duration_ms: number | null
          error: string | null
          field_confidence: Json | null
          filename: string
          id: string
          import_id: string
          outcome: string
          run_id: string
        }
        Insert: {
          attachment_id?: string | null
          confidence?: number | null
          created_at?: string
          doc_type?: string | null
          duration_ms?: number | null
          error?: string | null
          field_confidence?: Json | null
          filename: string
          id?: string
          import_id: string
          outcome: string
          run_id: string
        }
        Update: {
          attachment_id?: string | null
          confidence?: number | null
          created_at?: string
          doc_type?: string | null
          duration_ms?: number | null
          error?: string | null
          field_confidence?: Json | null
          filename?: string
          id?: string
          import_id?: string
          outcome?: string
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "processing_events_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "processing_events_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "processing_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "processing_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      processing_runs: {
        Row: {
          chunk_size: number
          concurrency: number
          created_at: string
          failed_count: number
          finished_at: string | null
          id: string
          import_id: string
          kind: string
          notes: string | null
          processed_count: number
          started_at: string
          status: string
          total_files: number
          user_id: string | null
        }
        Insert: {
          chunk_size?: number
          concurrency?: number
          created_at?: string
          failed_count?: number
          finished_at?: string | null
          id?: string
          import_id: string
          kind?: string
          notes?: string | null
          processed_count?: number
          started_at?: string
          status?: string
          total_files?: number
          user_id?: string | null
        }
        Update: {
          chunk_size?: number
          concurrency?: number
          created_at?: string
          failed_count?: number
          finished_at?: string | null
          id?: string
          import_id?: string
          kind?: string
          notes?: string | null
          processed_count?: number
          started_at?: string
          status?: string
          total_files?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "processing_runs_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "imports"
            referencedColumns: ["id"]
          },
        ]
      }
      record_sources: {
        Row: {
          attachment_id: string | null
          created_at: string
          id: string
          kind: string
          message_id: string | null
          record_id: string
          user_id: string | null
        }
        Insert: {
          attachment_id?: string | null
          created_at?: string
          id?: string
          kind: string
          message_id?: string | null
          record_id: string
          user_id?: string | null
        }
        Update: {
          attachment_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          message_id?: string | null
          record_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "record_sources_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "record_sources_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "record_sources_record_id_fkey"
            columns: ["record_id"]
            isOneToOne: false
            referencedRelation: "request_records"
            referencedColumns: ["id"]
          },
        ]
      }
      request_records: {
        Row: {
          amount_paid: number | null
          confidence: number | null
          created_at: string
          currency: string | null
          facility_name: string | null
          id: string
          import_id: string
          issues: Json
          items: Json
          needs_review: boolean
          notes: string | null
          payment_date: string | null
          request_date: string | null
          requester_name: string | null
          requester_phone: string | null
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          amount_paid?: number | null
          confidence?: number | null
          created_at?: string
          currency?: string | null
          facility_name?: string | null
          id?: string
          import_id: string
          issues?: Json
          items?: Json
          needs_review?: boolean
          notes?: string | null
          payment_date?: string | null
          request_date?: string | null
          requester_name?: string | null
          requester_phone?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          amount_paid?: number | null
          confidence?: number | null
          created_at?: string
          currency?: string | null
          facility_name?: string | null
          id?: string
          import_id?: string
          issues?: Json
          items?: Json
          needs_review?: boolean
          notes?: string | null
          payment_date?: string | null
          request_date?: string | null
          requester_name?: string | null
          requester_phone?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "request_records_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "imports"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_attachments: {
        Args: {
          _import_id: string
          _limit: number
          _max_bytes?: number
          _min_bytes?: number
        }
        Returns: {
          filename: string
          id: string
          message_seq: number
          mime_type: string
          size_bytes: number
          storage_path: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
