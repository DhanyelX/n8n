import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { GoogleGenerativeAI } from 'https://esm.sh/@google/generative-ai@0.1.3'
import { v4 as uuidv4 } from 'https://esm.sh/uuid@9.0.1'

const EVO_URL = Deno.env.get('EVOLUTION_API_URL')!
const EVO_KEY = Deno.env.get('EVOLUTION_API_KEY')!
const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // Bold
    .replace(/\*(.+?)\*/g, '$1')      // Italic
    .replace(/_(.+?)_/g, '$1')        // Italic underscore
    .replace(/~~(.+?)~~/g, '$1')      // Strikethrough
    .replace(/`(.+?)`/g, '$1')        // Inline code
    .replace(/```[\s\S]*?```/g, '')   // Code blocks
    .replace(/#{1,6}\s+/g, '')        // Headers
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // Links
    .trim()
}

serve(async (req) => {
  // Health check endpoint
  if (req.method === 'GET') {
    return new Response(
      JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    )
  }

  try {
    const payload = await req.json()
    console.log('=== WEBHOOK RECEIVED ===')
    console.log('Full payload:', JSON.stringify(payload, null, 2))
    console.log('Event type:', payload.event)

    // Handle connection updates
    if (payload.event === 'connection.update' || payload.event === 'CONNECTION_UPDATE') {
      const instanceId = payload.instance
      const state = payload.data?.state || payload.data?.connection

      console.log('Connection update:', { instanceId, state })

      if (state && instanceId) {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

        const statusMap: Record<string, string> = {
          'open': 'connected',
          'connecting': 'connecting',
          'close': 'disconnected'
        }

        const newStatus = statusMap[state] || 'disconnected'
        console.log(`Updating instance ${instanceId} status to: ${newStatus}`)

        await supabase
          .from('instances')
          .update({ status: newStatus })
          .eq('instance_id', instanceId)

        // Remedy disconnection by attempting reconnect
        if (state === 'close') {
          console.log('Instance disconnected, attempting reconnect...');
          const reconnectRes = await fetch(`${EVO_URL}/instance/connect/${instanceId}`, {
            method: 'GET',
            headers: { 'apikey': EVO_KEY }
          });
          console.log('Reconnect response status:', reconnectRes.status);
        }
      }

      return new Response('OK', { status: 200 })
    }

    // Handle QR code updates
    if (payload.event === 'qrcode.updated' || payload.event === 'QRCODE_UPDATED') {
      const instanceId = payload.instance
      const qrCode = payload.data?.qrcode?.base64

      console.log('QR code updated:', instanceId)

      if (qrCode && instanceId) {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

        await supabase
          .from('instances')
          .update({ qr_code: qrCode })
          .eq('instance_id', instanceId)
      }

      return new Response('OK', { status: 200 })
    }

    // Handle message events - CHECK ALL POSSIBLE EVENT NAMES
    const isMessageEvent =
      payload.event === 'messages.upsert' ||
      payload.event === 'MESSAGES_UPSERT' ||
      payload.event === 'message.upsert' ||
      payload.event === 'MESSAGE_UPSERT'

    console.log('Is message event?', isMessageEvent)
    console.log('Event name:', payload.event)

    if (!isMessageEvent) {
      console.log('Not a message event, skipping')
      return new Response('OK', { status: 200 })
    }

    const data = payload.data
    console.log('Message data exists?', !!data)
    console.log('Message object exists?', !!data?.message)

    if (!data || !data.message) {
      console.log('No message data, payload.data:', JSON.stringify(data, null, 2))
      return new Response('OK', { status: 200 })
    }

    // Ignore messages from self
    console.log('From me?', data.key?.fromMe)
    if (data.key?.fromMe) {
      console.log('Message from self, skipping')
      return new Response('OK', { status: 200 })
    }

    const instanceId = payload.instance
    const sender = data.key?.remoteJid
    const messageId = data.key?.id

    console.log('Instance ID:', instanceId)
    console.log('Sender:', sender)
    console.log('Message ID:', messageId)

    // Extract message text
    const messageText =
      data.message?.conversation ||
      data.message?.extendedTextMessage?.text ||
      data.message?.imageMessage?.caption ||
      data.message?.videoMessage?.caption ||
      null

    console.log('Message text:', messageText)
    console.log('Message object keys:', Object.keys(data.message || {}))

    // Check for media (e.g., images) and forward to handover if applicable
    const isImageMessage = !!data.message.imageMessage;
    console.log('Is image message?', isImageMessage);

    // Use Service Role Key (bypasses RLS)
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // Fetch instance from database and enrich with schema details
    console.log('Fetching instance from database...')
    const { data: instance, error: instanceError } = await supabase
      .from('instances')
      .select('user_id, status, id, instance_id, business_name, instance_name')
      .eq('instance_id', instanceId)
      .single()

    console.log('Instance found?', !!instance)
    console.log('Instance status:', instance?.status)
    console.log('Instance error?', instanceError)

    if (instanceError || !instance) {
      console.error('Instance not found:', instanceId, instanceError)
      return new Response('Instance not found', { status: 200 })
    }

    if (instance.status !== 'connected') {
      console.log('Instance not connected, current status:', instance.status)
      return new Response('OK', { status: 200 })
    }

    // Fetch agent config INCLUDING ALL NEW FIELDS (review_link, handover_phone, etc)
    console.log('Fetching agent config...')
    const { data: config } = await supabase
      .from('agent_configs')
      .select(`
        *,
        personality_doc:agent_training_documents(content)
      `)
      .eq('user_id', instance.user_id)
      .single();

    console.log('Config found?', !!config)
    // Unpack personality content if available
    let personalityContent = '';
    if (config?.personality_doc?.content) {
      personalityContent = config.personality_doc.content;
      console.log('Personality content loaded from training doc.');
    } else if (config?.personality_doc_id) {
      const { data: doc } = await supabase
        .from('agent_training_documents')
        .select('content')
        .eq('id', config.personality_doc_id)
        .single();
      if (doc) {
        personalityContent = doc.content;
        console.log('Personality content loaded from training doc by id.');
      }
    }

    if (!messageText && !isImageMessage) {
      console.log('No text content found and not an image; stopping.')
      console.log('Message structure:', JSON.stringify(data.message, null, 2))
      return new Response('OK', { status: 200 })
    }

    console.log('=== PROCESSING MESSAGE ===')
    console.log('Instance:', instanceId)
    console.log('From:', sender)
    console.log('Text:', messageText)

    // Session ID lookup and creation logic (robust to schema differences and race conditions)
    let simpleSessionId: string
    let finalChatSessionId: string

    const ownerUserId = instance.user_id
    const currentInstanceUuid = instance.id

    // We'll attempt a scoped lookup if owner_user_id exists; otherwise fallback.
    let simpleSessionData: any = null
    let schemaHasOwnerColumn = true

    try {
      // Try scoped lookup first
      const scopedRes = await supabase
        .from('sessions')
        .select('id, lead_id')
        .eq('user_jid', sender)
        .eq('owner_user_id', ownerUserId)
        .maybeSingle()

      if (scopedRes.error) {
        // If owner_user_id doesn't exist in the schema, detect that and fallback
        if (/owner_user_id/i.test(String(scopedRes.error.message || '')) && /does not exist/i.test(String(scopedRes.error.message || ''))) {
          schemaHasOwnerColumn = false
          console.warn('Scoped session lookup failed due to missing owner_user_id column; falling back to unscoped lookup.')
        } else {
          // Unknown error — log and continue to fallback
          console.warn('Scoped session lookup returned error, falling back to unscoped lookup:', scopedRes.error.message)
        }
      } else {
        simpleSessionData = scopedRes.data
      }
    } catch (e) {
      // Unexpected exception — log and fallback
      console.warn('Scoped session lookup exception, falling back to unscoped lookup:', e)
      schemaHasOwnerColumn = false
    }

    // If scoped lookup wasn't performed or didn't return data, do unscoped lookup
    if (!simpleSessionData) {
      try {
        const fallbackRes = await supabase
          .from('sessions')
          .select('id, lead_id')
          .eq('user_jid', sender)
          .maybeSingle()
        simpleSessionData = fallbackRes.data
      } catch (e) {
        console.warn('Unscoped session lookup failed:', e)
        simpleSessionData = null
      }
    }

    if (simpleSessionData) {
      simpleSessionId = simpleSessionData.id
      console.log(`[Session] Found existing simple session: ${simpleSessionId}`)
    } else {
      // Create session - prefer including owner_user_id if schema supports it
      simpleSessionId = uuidv4()
      const payloadWithOwner: any = {
        id: simpleSessionId,
        user_jid: sender,
        instance_id: currentInstanceUuid
      }
      if (schemaHasOwnerColumn) payloadWithOwner.owner_user_id = ownerUserId

      try {
        const insertRes = await supabase.from('sessions').insert(payloadWithOwner)
        if (insertRes.error) {
          // Handle duplicate key (race) by fetching existing row, otherwise handle missing column by retrying without owner_user_id
          const errMsg = String(insertRes.error.message || '')
          console.error('[Session Error] Failed to create new simple session:', insertRes.error)
          if (/duplicate key value violates unique constraint/i.test(errMsg) || /23505/.test(errMsg)) {
            console.warn('Duplicate session insert detected — fetching existing session row.')
            try {
              // Try to fetch the existing session by the composite key if owner_user_id is present, otherwise by user_jid
              let existingQuery = supabase.from('sessions').select('id, lead_id')
                .eq('user_jid', sender)

              if (schemaHasOwnerColumn) existingQuery = existingQuery.eq('owner_user_id', ownerUserId)

              const existingRes = await existingQuery.maybeSingle()
              if (existingRes.error) {
                console.error('Failed to fetch existing session after duplicate key error:', existingRes.error)
                return new Response(JSON.stringify({ error: 'Session creation race and fetch failed' }), { status: 500 })
              }
              if (!existingRes.data) {
                console.error('Duplicate key error reported but no existing session found. Aborting.')
                return new Response(JSON.stringify({ error: 'Session creation failed (duplicate key but no row found)' }), { status: 500 })
              }
              simpleSessionId = existingRes.data.id
              simpleSessionData = existingRes.data
              console.log('[Session] Recovered existing session after duplicate error:', simpleSessionId)
            } catch (e) {
              console.error('Exception while recovering existing session after duplicate error:', e)
              return new Response(JSON.stringify({ error: 'Session creation failed' }), { status: 500 })
            }
          } else if (/owner_user_id/i.test(errMsg) && /does not exist/i.test(errMsg)) {
            // Schema doesn't have owner_user_id; retry without it
            console.warn('owner_user_id column not present - retrying session create without owner_user_id (fallback).')
            try {
              const insertRes2 = await supabase.from('sessions').insert({
                id: simpleSessionId,
                user_jid: sender,
                instance_id: currentInstanceUuid
              })
              if (insertRes2.error) {
                console.error('[Session Error] Failed to create new simple session (fallback):', insertRes2.error)
                return new Response(JSON.stringify({ error: 'Session creation failed' }), { status: 500 })
              }
              console.log(`[Session] Created new simple session (fallback): ${simpleSessionId}`)
            } catch (e) {
              console.error('[Session Exception] Failed to create session (fallback):', e)
              return new Response(JSON.stringify({ error: 'Session creation failed' }), { status: 500 })
            }
          } else {
            // Unknown insert error
            return new Response(JSON.stringify({ error: 'Session creation failed' }), { status: 500 })
          }
        } else {
          console.log(`[Session] Created new simple session: ${simpleSessionId}`)
        }
      } catch (e) {
        console.error('[Session Exception] Failed to create session:', e)
        return new Response(JSON.stringify({ error: 'Session creation failed' }), { status: 500 })
      }

      // reload basic session data
      try {
        const reload = await supabase.from('sessions').select('id, lead_id').eq('id', simpleSessionId).maybeSingle()
        simpleSessionData = reload.data
      } catch (e) {
        console.warn('Failed to reload session after create:', e)
      }
    }

    // Now attempt to load optional session metadata (awaiting_images etc.) if those columns exist.
    // We do this in a guarded fashion so missing columns won't blow up the function.
    try {
      const metaRes = await supabase
        .from('sessions')
        .select('awaiting_images, image_request_description, images_received_count')
        .eq('id', simpleSessionId)
        .maybeSingle()

      if (!metaRes.error && metaRes.data) {
        simpleSessionData = { ...(simpleSessionData || {}), ...metaRes.data }
      } else if (metaRes.error) {
        // If columns don't exist, log once and continue
        if (/does not exist/i.test(String(metaRes.error.message || ''))) {
          console.warn('Optional session columns not present (awaiting_images etc.). Continuing without them.')
        } else {
          console.warn('Error fetching optional session metadata (non-blocking):', metaRes.error.message)
        }
      }
    } catch (e) {
      console.warn('Exception while fetching optional session metadata (non-blocking):', e)
    }

    // Create or ensure rich chat session exists
    finalChatSessionId = simpleSessionId

    const { error: chatSessionError } = await supabase.from('chat_sessions').upsert(
      {
        id: finalChatSessionId,
        user_id: ownerUserId,
        instance_id: currentInstanceUuid,
      },
      { onConflict: 'id', ignoreDuplicates: true }
    )

    if (chatSessionError) {
      console.error('[Session Error] Failed to ensure rich chat session exists:', chatSessionError)
    }

    // Lead creation/update
    console.log('Managing lead record...')
    const phoneNumber = sender.replace('@s.whatsapp.net', '')
    const leadName = data.pushName || phoneNumber

    const { data: existingLead } = await supabase
      .from('leads')
      .select('id')
      .eq('user_id', ownerUserId)
      .eq('phone', phoneNumber)
      .maybeSingle()

    let leadId: string | undefined

    if (existingLead) {
      leadId = existingLead.id
      await supabase
        .from('leads')
        .update({
          last_interaction: new Date().toISOString(),
          name: leadName
        })
        .eq('id', leadId)
      console.log('Updated existing lead:', leadId)
    } else {
      const newLeadId = uuidv4()
      const { error: leadError } = await supabase
        .from('leads')
        .insert({
          id: newLeadId,
          user_id: ownerUserId,
          name: leadName,
          phone: phoneNumber,
          status: 'New',
          last_interaction: new Date().toISOString()
        })

      if (leadError) {
        console.error('Failed to create lead:', leadError)
      } else {
        leadId = newLeadId
        console.log('Created new lead:', leadId)
      }
    }

    // Link session to lead if we have one
    if (leadId) {
      try {
        await supabase
          .from('sessions')
          .update({ lead_id: leadId })
          .eq('id', simpleSessionId)
      } catch (e) {
        console.warn('Failed to update session.lead_id (non-blocking):', e)
      }

      try {
        await supabase
          .from('chat_sessions')
          .update({ lead_id: leadId })
          .eq('id', finalChatSessionId)
      } catch (e) {
        console.warn('Failed to update chat_sessions.lead_id (non-blocking):', e)
      }
    }

    // Fetch conversation history (last 20 messages for context)
    console.log('Fetching conversation history...')
    const { data: conversationHistory } = await supabase
      .from('chat_messages')
      .select('role, content, timestamp')
      .eq('session_id', finalChatSessionId)
      .order('timestamp', { ascending: true })
      .limit(20)

    console.log('History messages found:', conversationHistory?.length || 0)

    // Fetch products
    console.log('Fetching products...')
    const { data: products } = await supabase
      .from('products')
      .select('*')
      .eq('user_id', instance.user_id)
      .eq('is_active', true)

    console.log('Products found:', products?.length || 0)

    // Fetch customer notes for memory/context
    console.log('Fetching customer notes...')
    const { data: notes } = leadId
      ? await supabase
          .from('customer_notes')
          .select('note_type, content, extracted_at')
          .eq('lead_id', leadId)
          .order('extracted_at', { ascending: false })
          .limit(20)
      : { data: [] }

    let notesContext = "";
    if (notes && notes.length > 0) {
      notesContext = "\n\n## CUSTOMER NOTES\n";
      notes.forEach((note: any) => {
        notesContext += `${note.note_type}: ${note.content}\n`;
      });
      notesContext += "\n";
    }

    // Build AI prompt
    const productList = products && products.length > 0
      ? products.map((p: any) =>
          `- ${p.name} ($${p.price})${p.description ? ': ' + p.description : ''}`
        ).join('\n')
      : "No products available."

    // Build conversation history context
    let conversationContext = ''
    if (conversationHistory && conversationHistory.length > 0) {
      conversationContext = '\n\n## CONVERSATION HISTORY\n'
      conversationHistory.forEach((msg: any) => {
        conversationContext += `${msg.role === 'user' ? 'Customer' : 'You'}: ${msg.content}\n`
      })
      conversationContext += '\n'
    }

    // Enrich with customer images from session/lead
    console.log('Fetching customer images for session/lead...')
    const { data: imageRecords } = await supabase
      .from('customer_images')
      .select('image_url, caption, mime_type, created_at, forwarded_to_owner')
      .eq('session_id', finalChatSessionId)
      .order('created_at', { ascending: false })
      .limit(10)

    let imagesContext = ''
    if (imageRecords && imageRecords.length > 0) {
      imagesContext = '\n\n## RECENT CUSTOMER IMAGES\n'
      imageRecords.forEach((img: any) => {
        imagesContext += `Image: ${img.image_url}${img.caption ? ', Caption: ' + img.caption : ''}${img.forwarded_to_owner ? ', forwarded to owner' : ''}\n`
      })
      imagesContext += '\n'
    }

    // Build full system prompt with all context and a strict guard against inventing products
    const systemPrompt = `
# WAMPIA AI AGENT MASTER SYSTEM PROMPT

## IDENTITY & ESSENCE

You are Wampia, an AI agent on a mission to turn every conversation into a moment that feels personal, meaningful, and valuable.  
You are not pretending to be human—but you embody the best of what makes people feel seen, heard, and helped: warmth, insight, and authenticity.

CRITICAL: DO NOT INVENT PRODUCTS OR INVENTORY. Only reference products listed in the "Available Products" section below. If none are available, respond: "No products available." Do not guess, fabricate, or assume any product beyond those explicitly shown.

## BUSINESS CONTEXT

- **Instance Name:** ${instance?.instance_name || ''}
- **Business Name:** ${instance?.business_name || ''}
- **Business Owner:** ${config?.business_owner_name || ''}
- **Tone:** ${config?.tone || 'Professional and friendly'}
- **Business Hours:** ${config?.business_hours || 'Always available'}
- **Handover Phone:** ${config?.handover_phone || 'not set'}
- **Handover Message:** ${config?.handover_message || 'not set'}
- **Google Review Link:** ${config?.review_link || 'not set'}
- **Auto-share review link:** ${config?.auto_share_review_link ? 'Enabled' : 'Disabled'}

Available Products:
${productList}
${conversationContext}
${imagesContext}
${notesContext}
## PERSONALITY GUIDELINES
${personalityContent}

## FINAL PRINCIPLE

In every interaction, ask yourself: "If I were the customer in this situation, would I feel heard, helped, and valued?" If the answer is yes, you're embodying Wampia's standard of excellence.

## CURRENT CUSTOMER MESSAGE
${messageText}
    `.trim()

    // Call Gemini AI
    console.log('Calling Gemini AI...')
    const genAI = new GoogleGenerativeAI(GEMINI_KEY)
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" })

    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: systemPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 500,
      }
    })

    let aiResponse = result.response.text()
    console.log('=== AI RESPONSE ===')
    console.log('Response:', aiResponse)

    // Check for [HANDOVER] and handle if present
    let handoverSummary = '';
    if (aiResponse.startsWith('[HANDOVER]')) {
      const handoverMatch = aiResponse.match(/\[HANDOVER\] Summary: (.*?)\n/);
      if (handoverMatch) {
        handoverSummary = handoverMatch[1];
        aiResponse = aiResponse.replace(/\[HANDOVER\] Summary: .*?\n/, '');
        if (config?.handover_phone) {
          const handoverNumber = config.handover_phone.endsWith('@s.whatsapp.net') ? config.handover_phone : `${config.handover_phone}@s.whatsapp.net`;
          const handoverPayload = {
            number: handoverNumber,
            text: `Handover case from ${sender.replace('@s.whatsapp.net', '')}: ${handoverSummary}\nCustomer message: ${messageText}`,
            delay: 1200
          };
          const handoverRes = await fetch(`${EVO_URL}/message/sendText/${instanceId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
            body: JSON.stringify(handoverPayload)
          });
          console.log('Handover send status:', handoverRes.status);
        }
      }
    }

    // Check for [UPDATE] and store key details in leads.notes
    const updateMatch = aiResponse.match(/\[UPDATE\] ([\s\S]*)/);
    if (updateMatch && leadId) {
      try {
        const updateJson = JSON.parse(updateMatch[1]);
        let newNotes = '';
        for (const [key, value] of Object.entries(updateJson)) {
          newNotes += `\n${key}: ${value}`;
          // Save to customer_notes table
          await supabase
            .from('customer_notes')
            .insert({
              lead_id: leadId,
              session_id: finalChatSessionId,
              note_type: key,
              content: `${value}`,
              extracted_at: new Date().toISOString()
            })
        }
        const { data: lead } = await supabase.from('leads').select('notes').eq('id', leadId).single();
        const updatedNotes = (lead?.notes || '') + newNotes;
        await supabase.from('leads').update({ notes: updatedNotes }).eq('id', leadId);
        console.log('Updated lead notes and customer_notes with key details.');
        aiResponse = aiResponse.replace(/\[UPDATE\] [\s\S]*/, '');  // Remove from response
      } catch (e) {
        console.error('Failed to parse/update key details:', e);
      }
    }

    const cleanResponse = stripMarkdown(aiResponse)
    console.log('Clean response:', cleanResponse)

    // Send reply via Evolution API
    console.log('Sending reply via Evolution API...')
    const sendPayload = {
      number: sender,
      text: cleanResponse,
      delay: 1200
    }
    console.log('Send payload:', JSON.stringify(sendPayload, null, 2))

    const sendRes = await fetch(`${EVO_URL}/message/sendText/${instanceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVO_KEY
      },
      body: JSON.stringify(sendPayload)
    })

    console.log('Send response status:', sendRes.status)
    const sendData = await sendRes.json()
    console.log('Send response data:', JSON.stringify(sendData, null, 2))

    if (!sendRes.ok) {
      console.error('Failed to send message:', sendData)
    } else {
      console.log('✓ Reply sent successfully')
    }

    // Log conversation
    console.log('Logging conversation to database...')
    const { error: logError } = await supabase.from('chat_messages').insert([
      {
        session_id: finalChatSessionId,
        instance_id: instanceId,
        sender: sender,
        message_id: messageId,
        role: 'user',
        content: messageText,
        timestamp: new Date().toISOString()
      },
      {
        session_id: finalChatSessionId,
        instance_id: instanceId,
        sender: sender,
        role: 'assistant',
        content: aiResponse,
        timestamp: new Date().toISOString()
      }
    ])

    if (logError) {
      console.error('Failed to log conversation:', logError)
    } else {
      console.log('✓ Conversation logged')
    }

    console.log('=== REQUEST COMPLETE ===')
    return new Response('OK', { status: 200 })

  } catch (error) {
    console.error('=== WEBHOOK ERROR ===')
    console.error('Error name:', error.name)
    console.error('Error message:', error.message)
    console.error('Error stack:', error.stack)

    // CRITICAL: Always return 200 to prevent instance deletion
    return new Response('OK', { status: 200 })
  }
})
