using System;using System.IO;using System.Windows.Forms;
class Probe:Form {
 readonly string report=Environment.GetEnvironmentVariable("VANZY_MACRO_PROBE_REPORT");
 readonly TextBox input=new TextBox();readonly Button button=new Button();readonly Timer timer=new Timer();
 Probe(){Text="VANZY isolated macro probe (auto closes)";Width=430;Height=170;StartPosition=FormStartPosition.CenterScreen;
 input.Top=15;input.Left=15;input.Width=370;input.TabIndex=0;
 button.Text="Harmless input test";button.Top=55;button.Left=15;button.Width=370;button.TabIndex=1;
 button.Click+=(s,e)=>File.AppendAllText(report,"button-click\n");Controls.Add(input);Controls.Add(button);
 Shown+=(s,e)=>{input.Focus();File.AppendAllText(report,"shown\n");};
 timer.Interval=5000;timer.Tick+=(s,e)=>{timer.Stop();Close();};timer.Start();}
 [STAThread]static void Main(){Application.EnableVisualStyles();Application.Run(new Probe());}
}
