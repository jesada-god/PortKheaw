'use client';
import { useState } from 'react';
import Header from '@/src/components/layout/Header';
import { Shuffle, TrendingUp, ChevronRight, Lock } from 'lucide-react';
import { Tabs } from '@/src/components/ui/Tabs';
import { useRouter } from 'next/navigation';

const toolsList = [
  {
    id: 'what-if',
    title: 'จำลองสถานการณ์ (What-If Analysis)',
    description: 'วิเคราะห์ผลกระทบหากต้นทุนหรือราคาขายเปลี่ยน',
    icon: Shuffle,
    tag: 'PRO',
    category: 'จำลองสถานการณ์',
    route: '/tools/what-if'
  },
  {
    id: 'monte-carlo',
    title: 'Monte Carlo Simulation',
    description: 'พยากรณ์ความน่าจะเป็นของราคาในอนาคต',
    icon: TrendingUp,
    tag: 'PRO',
    category: 'วิเคราะห์ความเสี่ยง',
    route: '/tools/monte-carlo'
  }
];

export default function ToolsPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('ทั้งหมด');

  const filteredTools = activeTab === 'ทั้งหมด' 
    ? toolsList 
    : toolsList.filter(t => t.category === activeTab);

  return (
    <div>
      <Header title="เครื่องมือวิเคราะห์ (Tools)" subtitle="เครื่องมือจำลองสถานการณ์และความเสี่ยง" />
      
      <div className="p-4 md:p-8 space-y-6">
        <Tabs 
          tabs={['ทั้งหมด', 'จำลองสถานการณ์', 'วิเคราะห์ความเสี่ยง']}
          activeTab={activeTab} 
          onChange={setActiveTab} 
        />

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-6">
          {filteredTools.map((tool) => (
            <div 
              key={tool.id} 
              onClick={() => router.push(tool.route)}
              className="bg-[#151B28] rounded-2xl border border-slate-800 p-6 flex flex-col justify-between hover:border-[#D4FF00]/50 hover:bg-[#1e293b] transition-all cursor-pointer group shadow-xl relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-32 h-32 bg-slate-800/20 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110" />
              
              <div className="relative z-10">
                <div className="flex justify-between items-start mb-4">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                    tool.tag === 'PRO' ? 'bg-purple-500/10 text-purple-400' : 'bg-[#D4FF00]/10 text-[#D4FF00]'
                  }`}>
                    <tool.icon size={24} />
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded tracking-wider ${
                    tool.tag === 'PRO' ? 'bg-purple-500/20 text-purple-400' : 'bg-[#1e293b] text-slate-400'
                  }`}>
                    {tool.tag === 'PRO' ? <span className="flex items-center gap-1"><Lock size={10}/> PRO</span> : tool.tag}
                  </span>
                </div>
                <h3 className="text-lg font-bold text-white mb-2 group-hover:text-[#D4FF00] transition-colors">{tool.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{tool.description}</p>
              </div>

              <div className="mt-6 flex items-center justify-between pt-4 border-t border-slate-800 relative z-10">
                <span className="text-[10px] text-slate-500 uppercase tracking-widest">{tool.category}</span>
                <div className="flex items-center gap-1 text-[#D4FF00] text-sm font-medium">
                  ใช้งาน <ChevronRight size={16} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
