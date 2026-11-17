import React, { useState, useEffect, useRef } from 'react';
import {
  MessageSquare,
  Send,
  X,
  Clock,
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  Car,
  RefreshCw,
} from 'lucide-react';
import {
  fetchOwnerSessionMessages,
  sendOwnerReply,
  acceptVisitorSession,
  closeOwnerVisitorSession,
  markSessionAsRead,
  updateSessionPriority,
} from '../../services/vehicleService';

export default function OwnerConversationModal({
  sessionId,
  session,
  onClose,
  onSessionUpdated,
}) {
  const effectiveSessionId = sessionId || session?.sessionId || '';
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [priorityLoading, setPriorityLoading] = useState(false);
  const [sessionState, setSessionState] = useState(session || {});

  const handlePriorityChange = async (newPriority) => {
    if (!effectiveSessionId || sessionState.priority === newPriority || priorityLoading) return;
    setPriorityLoading(true);
    try {
      await updateSessionPriority(effectiveSessionId, newPriority);
      const updated = { ...sessionState, priority: newPriority, priorityOverridden: true };
      setSessionState(updated);
      if (onSessionUpdated) onSessionUpdated(updated);
    } catch (err) {
      setError(err.message || 'Failed to update priority');
    } finally {
      setPriorityLoading(false);
    }
  };

  const messagesEndRef = useRef(null);
  const pollingRef = useRef(null);
  const abortControllerRef = useRef(null);
  const latestMessageIdRef = useRef(0);

  // Update sessionState if session prop updates
  useEffect(() => {
    if (session) {
      setSessionState((prev) => ({ ...prev, ...session }));
    }
  }, [session]);

  const scrollToBottom = () => {
    if (messagesEndRef.current && typeof messagesEndRef.current.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // Initial fetch of messages
  const loadMessages = async () => {
    if (!effectiveSessionId) return;
    setLoading(true);
    setError('');
    try {
      const data = await fetchOwnerSessionMessages(effectiveSessionId, { limit: 100 });
      const fetched = Array.isArray(data.messages) ? data.messages : [];
      setMessages(fetched);
      if (fetched.length > 0) {
        latestMessageIdRef.current = Math.max(...fetched.map((m) => Number(m.id) || 0));
      }
      // Auto-mark conversation as read on open
      markSessionAsRead(effectiveSessionId)
        .then(() => {
          if (onSessionUpdated) {
            onSessionUpdated({ sessionId: effectiveSessionId, unreadCount: 0 });
          }
        })
        .catch(() => {});
    } catch (err) {
      setError(err.message || 'Failed to load conversation history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMessages();
  }, [effectiveSessionId]);

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!loading && messages.length > 0) {
      scrollToBottom();
    }
  }, [loading]);

  // Periodic incremental polling for new messages while modal is open
  useEffect(() => {
    const isLive = sessionState.status === 'pending' || sessionState.status === 'accepted';
    if (!effectiveSessionId || !isLive) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    const poll = async () => {
      // Skip polling if document is hidden to conserve network
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const afterId = latestMessageIdRef.current;
        const res = await fetchOwnerSessionMessages(effectiveSessionId, {
          after: afterId,
          limit: 50,
          signal: controller.signal,
        });

        if (Array.isArray(res.messages) && res.messages.length > 0) {
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id));
            const fresh = res.messages.filter((m) => !existingIds.has(m.id));
            if (fresh.length === 0) return prev;
            const updated = [...prev, ...fresh];
            latestMessageIdRef.current = Math.max(...updated.map((m) => Number(m.id) || 0));

            // If fresh visitor message received while viewing conversation, auto mark as read
            const hasVisitorMsg = fresh.some((m) => m.senderType === 'visitor');
            if (hasVisitorMsg) {
              markSessionAsRead(effectiveSessionId)
                .then(() => {
                  if (onSessionUpdated) {
                    onSessionUpdated({ sessionId: effectiveSessionId, unreadCount: 0 });
                  }
                })
                .catch(() => {});
            }

            return updated;
          });
          scrollToBottom();
        }
      } catch {
        // Silently handle polling interruptions
      }
    };

    pollingRef.current = setInterval(poll, 4000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [effectiveSessionId, sessionState.status]);

  // Escape key handler
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSendReply = async (e) => {
    e?.preventDefault();
    const trimmed = replyText.trim();
    if (!trimmed || sending || !effectiveSessionId) return;

    setSending(true);
    setError('');

    const clientMsgId = `cm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    try {
      const res = await sendOwnerReply(effectiveSessionId, trimmed, clientMsgId);
      if (res.status === 'sent' && res.message) {
        setReplyText('');
        setMessages((prev) => {
          if (prev.some((m) => m.id === res.message.id || (m.clientMessageId && m.clientMessageId === clientMsgId))) {
            return prev;
          }
          const updated = [...prev, res.message];
          latestMessageIdRef.current = Math.max(latestMessageIdRef.current, Number(res.message.id) || 0);
          return updated;
        });
        scrollToBottom();
      }
    } catch (err) {
      setError(err.message || 'Failed to send reply');
    } finally {
      setSending(false);
    }
  };

  const handleAccept = async () => {
    if (!effectiveSessionId) return;
    setActionLoading(true);
    setError('');
    try {
      const res = await acceptVisitorSession(effectiveSessionId);
      if (res.status === 'accepted') {
        const updated = { ...sessionState, status: 'accepted', acceptedAt: res.acceptedAt };
        setSessionState(updated);
        if (onSessionUpdated) onSessionUpdated(updated);
      }
    } catch (err) {
      setError(err.message || 'Failed to accept session');
    } finally {
      setActionLoading(false);
    }
  };

  const handleClose = async () => {
    if (!effectiveSessionId) return;
    setActionLoading(true);
    setError('');
    try {
      const res = await closeOwnerVisitorSession(effectiveSessionId);
      if (res.status === 'closed') {
        const updated = { ...sessionState, status: 'closed', closedAt: res.closedAt };
        setSessionState(updated);
        if (onSessionUpdated) onSessionUpdated(updated);
      }
    } catch (err) {
      setError(err.message || 'Failed to close session');
    } finally {
      setActionLoading(false);
    }
  };

  const isClosedOrExpired = sessionState.status === 'closed' || sessionState.status === 'expired';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Visitor Conversation"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-md animate-fadeIn"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-2xl bg-[#0c0c0c] border border-white/[0.1] rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 sm:p-5 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center space-x-3 min-w-0">
            <div className="w-10 h-10 rounded-xl border border-[#2ee6ca]/30 bg-[#2ee6ca]/10 flex items-center justify-center text-[#2ee6ca] shrink-0">
              <MessageSquare className="w-5 h-5" />
            </div>

            <div className="min-w-0">
              <div className="flex items-center space-x-2">
                <h2 className="font-mono text-sm sm:text-base font-bold text-white uppercase truncate">
                  {sessionState.vehicle?.vehicleModel || 'Vehicle'}{' '}
                  <span className="text-neutral-400">({sessionState.vehicle?.registrationNumber || 'PX'})</span>
                </h2>

                <span
                  className={`uppercase px-2 py-0.5 rounded text-[10px] font-semibold shrink-0 ${
                    sessionState.status === 'pending'
                      ? 'bg-amber-400/10 text-amber-400 border border-amber-400/30'
                      : sessionState.status === 'accepted'
                      ? 'bg-[#2ee6ca]/10 text-[#2ee6ca] border border-[#2ee6ca]/30'
                      : 'bg-neutral-800 text-neutral-400'
                  }`}
                >
                  {sessionState.status}
                </span>

                {/* Priority Badge */}
                <span
                  className={`uppercase px-2 py-0.5 rounded text-[10px] font-semibold shrink-0 border ${
                    sessionState.priority === 'urgent'
                      ? 'bg-red-500/20 text-red-400 border-red-500/40'
                      : sessionState.priority === 'high'
                      ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                      : sessionState.priority === 'low'
                      ? 'bg-neutral-800 text-neutral-400 border-neutral-700'
                      : 'bg-sky-500/20 text-sky-400 border-sky-500/40'
                  }`}
                >
                  {sessionState.priority || 'normal'}
                  {sessionState.priorityOverridden && ' *'}
                </span>
              </div>

              <p className="text-[11px] font-mono text-neutral-400 truncate">
                Ref: {effectiveSessionId}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close conversation"
            className="p-2 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.08] text-neutral-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Action Banner: Lifecycle Controls & Priority Override */}
        <div className="px-5 py-2.5 bg-white/[0.015] border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
          <div className="flex items-center space-x-3 text-neutral-400 text-[11px]">
            <div className="flex items-center space-x-1">
              <Clock className="w-3.5 h-3.5" />
              <span>Created: {new Date(sessionState.createdAt || Date.now()).toLocaleTimeString()}</span>
            </div>

            {/* Inline Priority Override */}
            <div className="flex items-center space-x-1.5 pl-2 border-l border-white/[0.08]">
              <span className="text-[10px] text-neutral-500 uppercase">Priority:</span>
              <div className="flex items-center space-x-1">
                {['urgent', 'high', 'normal', 'low'].map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={priorityLoading || sessionState.priority === p}
                    onClick={() => handlePriorityChange(p)}
                    className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-mono transition-colors ${
                      sessionState.priority === p
                        ? 'bg-white/20 text-white font-bold'
                        : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/[0.05]'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {sessionState.status === 'pending' && (
              <button
                onClick={handleAccept}
                disabled={actionLoading}
                className="inline-flex items-center space-x-1 px-3 py-1 rounded bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-semibold uppercase text-[10px] tracking-wider transition-colors disabled:opacity-50"
              >
                {actionLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                <span>Accept</span>
              </button>
            )}

            {(sessionState.status === 'pending' || sessionState.status === 'accepted') && (
              <button
                onClick={handleClose}
                disabled={actionLoading}
                className="inline-flex items-center space-x-1 px-2.5 py-1 rounded border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-400 uppercase text-[10px] tracking-wider transition-colors disabled:opacity-50"
              >
                {actionLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                <span>Close Session</span>
              </button>
            )}
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-5 mt-3 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-xs font-mono flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}

        {/* Message Thread Body */}
        <div className="flex-1 p-5 overflow-y-auto space-y-3 min-h-[250px] max-h-[50vh]">
          {loading ? (
            <div className="py-16 flex flex-col items-center justify-center space-y-2">
              <Loader2 className="w-6 h-6 text-[#2ee6ca] animate-spin" />
              <span className="text-xs font-mono text-neutral-400">Loading conversation...</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <MessageSquare className="w-8 h-8 text-neutral-600 mx-auto" />
              <p className="text-xs font-mono text-neutral-400">
                No messages yet in this session.
              </p>
              <p className="text-[11px] font-mono text-neutral-500">
                You can send a reply below to initiate the conversation with the visitor.
              </p>
            </div>
          ) : (
            messages.map((m) => {
              const isOwner = m.senderType === 'owner';
              return (
                <div
                  key={m.id || m.clientMessageId}
                  className={`flex flex-col ${isOwner ? 'items-end' : 'items-start'}`}
                >
                  <div className="flex items-center space-x-1.5 pb-1 px-1 text-[10px] font-mono text-neutral-400">
                    <span className="font-semibold text-neutral-300">
                      {isOwner ? 'You (Owner)' : 'Visitor'}
                    </span>
                    {m.isAutoReply && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] bg-purple-500/20 text-purple-300 border border-purple-500/30">
                        Auto-reply
                      </span>
                    )}
                    {!isOwner && m.priority && (
                      <span
                        className={`uppercase px-1.5 py-0.5 rounded text-[9px] font-semibold border ${
                          m.priority === 'urgent'
                            ? 'bg-red-500/20 text-red-400 border-red-500/40'
                            : m.priority === 'high'
                            ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                            : m.priority === 'low'
                            ? 'bg-neutral-800 text-neutral-400 border-neutral-700'
                            : 'bg-sky-500/20 text-sky-400 border-sky-500/40'
                        }`}
                      >
                        {m.priority}
                      </span>
                    )}
                    <span>•</span>
                    <span>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>

                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs font-mono leading-relaxed break-words whitespace-pre-wrap ${
                      isOwner
                        ? 'bg-[#2ee6ca]/15 border border-[#2ee6ca]/40 text-[#2ee6ca]'
                        : 'bg-white/[0.04] border border-white/[0.08] text-neutral-200'
                    }`}
                  >
                    {m.body}
                  </div>

                  {!isOwner && m.priorityReason && !m.priorityReason.toLowerCase().includes('default') && (
                    <div className="px-2 pt-1 text-[10px] font-mono text-neutral-400">
                      <span className="text-neutral-500">AI intent:</span> {m.priorityReason}
                    </div>
                  )}
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Reply Input Area */}
        <div className="p-4 border-t border-white/[0.08] bg-white/[0.02]">
          {isClosedOrExpired ? (
            <div className="p-3 text-center rounded-lg border border-white/[0.06] bg-black/40 text-neutral-400 text-xs font-mono">
              This session is {sessionState.status}. No further replies can be sent.
            </div>
          ) : (
            <form onSubmit={handleSendReply} className="space-y-2">
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Type a reply to the visitor..."
                  maxLength={2000}
                  disabled={sending}
                  className="flex-1 bg-black/60 border border-white/[0.1] focus:border-[#2ee6ca]/60 focus:outline-none rounded-xl px-4 py-2.5 text-xs font-mono text-white placeholder-neutral-500 transition-colors"
                />

                <button
                  type="submit"
                  disabled={!replyText.trim() || sending}
                  className="px-4 py-2.5 rounded-xl bg-[#2ee6ca] hover:bg-[#28d1b7] text-black font-mono font-semibold text-xs uppercase tracking-wider flex items-center space-x-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(46,230,202,0.2)]"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  <span className="hidden sm:inline">Reply</span>
                </button>
              </div>

              <div className="flex justify-between items-center text-[10px] font-mono text-neutral-500 px-1">
                <span>{replyText.length} / 2000</span>
                <span>Press Enter to send reply</span>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
